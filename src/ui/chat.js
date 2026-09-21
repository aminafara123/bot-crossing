import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * The in-page conversation view: a thread's whole transcript, rendered the way the CLI
 * and desktop app show it, the person's messages, the agent's replies as markdown, its
 * thinking folded away, every tool call expandable to its input and result, with a
 * composer at the bottom that gets a message to the agent and shows the answer.
 *
 * The transcript on disk is the one source of truth. History arrives newest-window-first
 * from /api/chat/history and pages *backwards* with `until`, while the window is open it
 * *tails* the same file with `since`, so a turn that happened anywhere, here, in a
 * terminal, in the desktop app, shows up within a couple of seconds. Nothing has to be
 * closed and reopened.
 *
 * Sending differs by harness. Claude Code streams its turn back and the blocks are
 * rendered live, a local agent takes delivery (an inbox while it runs, a process with the
 * message on stdin when it does not) and the tail brings its answer as it writes it.
 *
 * The window floats: draggable by its header on a desktop (native resize corner too), a
 * near-fullscreen sheet on a phone where dragging the header resizes it. Minimize folds it
 * to the header and keeps tailing, close stops everything, killing a streamed turn.
 */

marked.use({ gfm: true, breaks: true })
const md = (text) => DOMPurify.sanitize(marked.parse(text))

const ICON_MIN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 12h14"/></svg>`
const ICON_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`
const ICON_SEND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12 20 4.5 15.5 20l-3.6-6.1L4.5 12z"/></svg>`

const TEMPLATE = `
  <header class="chat-head">
    <i class="dot"></i>
    <div class="chat-title"></div>
    <button class="btn icon ghost" data-act="min" title="Minimize">${ICON_MIN}</button>
    <button class="btn icon ghost" data-act="close" title="Close">${ICON_X}</button>
  </header>
  <div class="chat-msgs"></div>
  <form class="chat-input">
    <textarea rows="1" placeholder="Message this astronaut…" enterkeyhint="send"></textarea>
    <button class="btn primary icon" type="submit" title="Send">${ICON_SEND}</button>
  </form>
`

const PHONE = window.matchMedia('(max-width: 600px)')
const TAIL_MS = 2500
/** How long a delivered message may go unanswered before the composer is handed back. */
const DELIVERY_PATIENCE_MS = 15 * 60 * 1000

export class ChatWindow {
  constructor(root, { onToast } = {}) {
    this.onToast = onToast || (() => {})
    this.el = document.createElement('section')
    this.el.className = 'chat panel'
    this.el.innerHTML = TEMPLATE
    this.el.hidden = true
    root.appendChild(this.el)

    this.$ = (sel) => this.el.querySelector(sel)
    this.msgs = this.$('.chat-msgs')
    this.input = this.$('textarea')
    this.harness = 'claude-code'
    this.sessionId = ''
    this.folder = ''
    this.busy = false
    this._end = 0
    this._until = 0
    this._more = false
    this._pending = null
    this._echo = ''
    this._liveTools = new Map()

    this.$('[data-act="min"]').addEventListener('click', () => this.el.classList.toggle('min'))
    this.$('[data-act="close"]').addEventListener('click', () => this.close())
    this.$('.chat-input').addEventListener('submit', (e) => {
      e.preventDefault()
      this.send()
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.send()
      }
    })
    this.input.addEventListener('input', () => this._grow())
    this.$('.chat-head').addEventListener('click', (e) => {
      if (this.el.classList.contains('min') && !e.target.closest('[data-act]')) this.el.classList.remove('min')
    })

    this._wireDrag()
    this._wireKeyboard()
  }

  /** Open (or re-point) the window at a thread, show its transcript, and start tailing it. */
  async open({ harness = 'claude-code', sessionId = '', folder = '', title = 'Chat' }) {
    const changed = harness !== this.harness || sessionId !== this.sessionId || folder !== this.folder
    this.harness = harness
    this.sessionId = sessionId
    this.folder = folder
    this.$('.chat-title').textContent = title
    this.el.hidden = false
    this.el.classList.remove('min')
    if (changed) {
      this.msgs.innerHTML = ''
      this._end = 0
      this._until = 0
      this._more = false
      this._echo = ''
      this._settle()
      this._liveTools.clear()
      if (sessionId) await this._loadHistory()
      else this._note('A fresh thread starts in this folder with your first message.')
      this._scroll()
    }
    this._startTail()
    if (!PHONE.matches) this.input.focus()
  }

  close() {
    this.el.hidden = true
    this._abort?.abort()
    this._stopTail()
  }

  _qs(extra = '') {
    return `session=${encodeURIComponent(this.sessionId)}&harness=${encodeURIComponent(this.harness)}${extra}`
  }

  /** The latest window of the transcript, with an "earlier" control while more exists. */
  async _loadHistory() {
    const note = this._note('Loading the conversation…')
    try {
      const r = await fetch(`/api/chat/history?${this._qs()}`)
      const data = await r.json()
      note.remove()
      if (!data.ok) {
        this._note('No history on disk yet. new messages still reach the session.')
        return
      }
      this._until = data.until
      this._more = data.more
      this._end = data.end
      this._syncEarlier()
      for (const b of data.blocks) this.msgs.appendChild(this._block(b))
    } catch {
      note.remove()
      this._note('Could not load the history. new messages still work.')
    }
  }

  async _loadEarlier() {
    if (!this._more || this._loading) return
    this._loading = true
    const btn = this.$('.chat-earlier')
    if (btn) btn.textContent = 'loading…'
    try {
      const r = await fetch(`/api/chat/history?${this._qs(`&until=${this._until}`)}`)
      const data = await r.json()
      if (!data.ok) return
      this._until = data.until
      this._more = data.more
      const keep = this.msgs.scrollHeight - this.msgs.scrollTop
      for (const b of [...data.blocks].reverse()) {
        this.msgs.insertBefore(this._block(b), this.msgs.firstChild)
      }
      this._syncEarlier()
      // Keep the reader's place: the page grew above them, not under them.
      this.msgs.scrollTop = this.msgs.scrollHeight - keep
    } finally {
      this._loading = false
    }
  }

  _syncEarlier() {
    let btn = this.$('.chat-earlier')
    if (!this._more) {
      btn?.remove()
      return
    }
    if (!btn) {
      btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'chat-earlier'
      btn.addEventListener('click', () => this._loadEarlier())
    }
    btn.textContent = '↑ earlier in this conversation'
    this.msgs.insertBefore(btn, this.msgs.firstChild)
  }

  // ── the live tail ───────────────────────────────────────────────────────────────────

  _startTail() {
    this._stopTail()
    this._tailTimer = setInterval(() => this._tail(), TAIL_MS)
  }

  _stopTail() {
    clearInterval(this._tailTimer)
    this._tailTimer = null
  }

  /** Whatever the transcript gained since the last look, appended in place. */
  async _tail() {
    if (this.el.hidden || this._loading || this._streaming || !this.sessionId) return
    try {
      const r = await fetch(`/api/chat/history?${this._qs(`&since=${this._end}`)}`)
      const data = await r.json()
      if (!data.ok) return
      if (typeof data.end === 'number') this._end = data.end
      if (!data.blocks?.length) return
      const atBottom = this.msgs.scrollHeight - this.msgs.scrollTop - this.msgs.clientHeight < 80
      for (const b of data.blocks) {
        // The message sent from here comes back through the file too, it is shown once.
        if (b.kind === 'user' && this._echo && b.text === this._echo) {
          this._echo = ''
          continue
        }
        this.msgs.appendChild(this._block(b))
        if (b.kind !== 'user') this._settle()
      }
      if (atBottom) this._scroll()
    } catch {
      /* the next tick tries again */
    }
  }

  /** The wait is over, the pending note goes and the composer is handed back. */
  _settle() {
    this._pending?.remove()
    this._pending = null
    clearTimeout(this._patience)
    this.busy = false
  }

  /**
   * After a streamed turn the transcript is a new file, the resumed session's, already
   * holding everything shown here, so the tail restarts from its current end.
   */
  async _resync() {
    try {
      const r = await fetch(`/api/chat/history?${this._qs('&probe=1')}`)
      const data = await r.json()
      if (data.ok) this._end = data.end
    } catch {
      /* the tail will simply show a little more than it needs to */
    }
  }

  // ── rendering ───────────────────────────────────────────────────────────────────────

  /** One transcript block → one DOM node, in the CLI's own visual grammar. */
  _block(b) {
    if (b.kind === 'user') {
      const el = document.createElement('div')
      el.className = 'chat-block chat-msg user'
      el.textContent = b.text
      return el
    }
    if (b.kind === 'text') {
      const el = document.createElement('div')
      el.className = 'chat-block chat-msg bot rich'
      el.innerHTML = md(b.text)
      return el
    }
    if (b.kind === 'thinking') {
      const el = document.createElement('details')
      el.className = 'chat-block chat-think'
      const sum = document.createElement('summary')
      sum.textContent = '✻ thinking'
      const pre = document.createElement('pre')
      pre.textContent = b.text
      el.append(sum, pre)
      return el
    }
    const el = document.createElement('details')
    el.className = `chat-block chat-tool${b.isError ? ' err' : ''}`
    const sum = document.createElement('summary')
    const name = document.createElement('b')
    name.textContent = `⏺ ${b.name}`
    const line = document.createElement('span')
    line.textContent = b.line || ''
    sum.append(name, line)
    el.appendChild(sum)
    if (b.full) el.appendChild(this._pre('in', b.full))
    el.appendChild(this._pre('out', b.result || '(no result recorded)'))
    return el
  }

  _pre(cls, text) {
    const pre = document.createElement('pre')
    pre.className = cls
    pre.textContent = text
    return pre
  }

  // ── sending ─────────────────────────────────────────────────────────────────────────

  async send() {
    const text = this.input.value.trim()
    if (!text || this.busy) return
    this.busy = true
    this.input.value = ''
    this._grow()
    this.msgs.appendChild(this._block({ kind: 'user', text }))
    this._pending = this._note('thinking…', 'pending')
    this._scroll()

    if (this.harness !== 'claude-code') return this._deliver(text)

    this._streaming = true
    this._abort = new AbortController()
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: this.harness,
          sessionId: this.sessionId,
          folder: this.folder,
          prompt: text,
          allowEdits: true,
        }),
        signal: this._abort.signal,
      })
      if (!r.ok || !r.body) {
        const err = await r.json().catch(() => ({}))
        throw new Error(err.error || `The server said ${r.status}`)
      }
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (line) this._event(JSON.parse(line))
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') this._note(err.message || 'The send failed', 'err')
    } finally {
      this._streaming = false
      this._settle()
      await this._resync()
      this._scroll()
    }
  }

  /** A local agent: hand the message over, then let the tail bring the answer. */
  async _deliver(text) {
    this._echo = text
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: this.harness, sessionId: this.sessionId, folder: this.folder, prompt: text }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || `The server said ${r.status}`)
      if (data.sessionId && data.sessionId !== this.sessionId) {
        this.sessionId = data.sessionId
        this._end = 0
      }
      if (this._pending) {
        this._pending.textContent = data.mode === 'inbox' ? 'delivered. the agent is working…' : 'agent started. working…'
      }
      // The composer stays closed until the answer lands, so a second message cannot
      // overwrite the first in the inbox, with a limit, in case the agent never answers.
      this._patience = setTimeout(() => this._settle(), DELIVERY_PATIENCE_MS)
    } catch (err) {
      this._note(err.message || 'The send failed', 'err')
      this._settle()
    }
  }

  /** One line of Claude Code's live stream, rendered with the same grammar as the history. */
  _event(ev) {
    if (ev.session_id) this.sessionId = ev.session_id
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) {
          this.msgs.appendChild(this._block({ kind: 'text', text: block.text }))
        } else if (block.type === 'thinking' && block.thinking?.trim()) {
          this.msgs.appendChild(this._block({ kind: 'thinking', text: block.thinking }))
        } else if (block.type === 'tool_use') {
          const line = String(
            block.input?.command || block.input?.file_path || block.input?.pattern || block.input?.description || ''
          ).slice(0, 140)
          const el = this._block({ kind: 'tool', name: block.name, line, full: '', result: 'running…' })
          this._liveTools.set(block.id, el)
          this.msgs.appendChild(el)
        }
      }
      if (this._pending) this._pending.textContent = 'working…'
      this._scroll()
    } else if (ev.type === 'user') {
      for (const block of ev.message?.content || []) {
        if (block.type !== 'tool_result') continue
        const el = this._liveTools.get(block.tool_use_id)
        if (!el) continue
        const body =
          typeof block.content === 'string' ? block.content : (block.content || []).map((c) => c.text || '').join('\n')
        el.querySelector('pre.out').textContent = body.slice(0, 4000) || '(done)'
        if (block.is_error) el.classList.add('err')
      }
    } else if (ev.type === 'result' && ev.is_error) {
      this._note(String(ev.result || 'The turn failed').slice(0, 500), 'err')
    } else if (ev.type === 'server-error') {
      this._note(ev.error, 'err')
    }
  }

  _note(text, cls = '') {
    const el = document.createElement('div')
    el.className = `chat-note ${cls}`
    el.textContent = text
    this.msgs.appendChild(el)
    this._scroll()
    return el
  }

  _scroll() {
    this.msgs.scrollTop = this.msgs.scrollHeight
  }

  _grow() {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`
  }

  /** Header drag: moves the window on a desktop, resizes the sheet on a phone. */
  _wireDrag() {
    const head = this.$('.chat-head')
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-act]') || this.el.classList.contains('min')) return
      const rect = this.el.getBoundingClientRect()
      const sx = e.clientX
      const sy = e.clientY
      const move = (ev) => {
        if (PHONE.matches) {
          const h = Math.min(window.innerHeight * 0.94, Math.max(180, rect.height + (sy - ev.clientY)))
          this.el.style.top = 'auto'
          this.el.style.height = `${h}px`
        } else {
          this.el.style.left = `${Math.max(0, rect.left + ev.clientX - sx)}px`
          this.el.style.top = `${Math.max(0, rect.top + ev.clientY - sy)}px`
          this.el.style.right = 'auto'
          this.el.style.bottom = 'auto'
        }
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      head.setPointerCapture?.(e.pointerId)
    })
  }

  /** Follow the visual viewport so the composer rides above the soft keyboard. */
  _wireKeyboard() {
    const vv = window.visualViewport
    if (!vv) return
    const place = () => {
      if (!PHONE.matches || this.el.hidden) {
        this.el.style.transform = ''
        return
      }
      const covered = window.innerHeight - vv.height - vv.offsetTop
      this.el.style.transform = covered > 40 ? `translateY(-${covered}px)` : ''
      this._scroll()
    }
    vv.addEventListener('resize', place)
    vv.addEventListener('scroll', place)
  }
}
