/**
 * Harness adapter: Local Agent. Any agent you wrote yourself, in any language.
 *
 * The contract is two small files per run, written by the agent into one shared folder
 * (BOT_CROSSING_LOCAL_AGENT_SESSIONS, default ~/.local-agents/sessions):
 *
 *   <uuid>.json    a status card, rewritten atomically on every turn:
 *                  { id, agent, title, preview, project, projectPath, cwd, model, pid,
 *                    createdAt, lastActivityAt, state: "waiting" | "running" | "ended",
 *                    hasError }
 *   <uuid>.jsonl   the transcript, one message per line:
 *                  { ts, role: "user" | "assistant" | "tool", content, tool_calls?, tool_name? }
 *
 * The card already carries everything a thread needs, so the transcript is only stat'ed for
 * its size. A card whose pid is no longer a live process counts as ended, so a killed agent
 * does not keep hammering on the map forever.
 *
 * Read only, like every adapter. Getting a message to an agent is described here but done
 * by the server: a running agent watches <uuid>.inbox beside its card, an ended one is
 * started again with `python3 run.py <agent> --resume <uuid>` and the message on stdin.
 * A reference agent that speaks this contract lives in the README under "Local agents".
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { exists, jsonLines, listFiles, num, readWindow } from '../lib/fsutil.mjs'

const HOME = os.homedir()
const SESSIONS =
  process.env.BOT_CROSSING_LOCAL_AGENT_SESSIONS || path.join(HOME, '.local-agents', 'sessions')

/** The workshop: where `run.py` lives, one level up from the sessions it writes. */
const WORKSHOP = path.dirname(SESSIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SAFE_DIR = /^\/[\w./-]+$/

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `local-agent:${raw}`

/** Is that pid still a process? Signal 0 checks without sending anything. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM' // exists, just not ours
  }
}

async function readCard(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null // mid-write, or not one of ours
  }
}

async function scanThreads() {
  const threads = []
  for (const file of await listFiles(SESSIONS, (n) => n.endsWith('.json'))) {
    const card = await readCard(file)
    if (!card || !UUID.test(String(card.id || ''))) continue

    let sizeBytes = 0
    try {
      sizeBytes = (await fsp.stat(file.replace(/\.json$/, '.jsonl'))).size
    } catch {
      /* no transcript yet */
    }

    const live = card.state !== 'ended' && alive(card.pid)
    const projectPath = String(card.projectPath || '')
    const cwd = String(card.cwd || projectPath)
    threads.push({
      id: ID(card.id),
      title: String(card.title || 'Untitled thread').slice(0, 120),
      preview: String(card.preview || '').slice(0, 240),
      project: String(card.project || path.basename(projectPath) || 'local-agent'),
      projectPath,
      worktree: '',
      cwd,
      gitBranch: '',
      model: String(card.model || ''),
      effort: '',
      createdAt: num(card.createdAt),
      lastActivityAt: num(card.lastActivityAt),
      lastFocusedAt: 0,
      // "waiting" with a task already given means the agent answered and is waiting on you.
      unread: live && card.state === 'waiting' && Boolean(card.title),
      running: live && card.state === 'running',
      hasError: Boolean(card.hasError),
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      sizeBytes,
      source: String(card.agent || 'agent'),
      canOpen: false,
      ref: { sessionId: card.id, cwd },
    })
  }
  return threads
}

/** No URL scheme answers for a terminal program, so the honest offer is the command. */
function openThread(ref) {
  const id = String(ref?.sessionId || '')
  if (!UUID.test(id)) return { ok: false, error: 'Not a local-agent session' }
  const cwd = SAFE_DIR.test(String(ref?.cwd || '')) ? ref.cwd : '<agent folder>'
  return { ok: false, error: `No link for a terminal agent. Run: cd ${cwd} && python3 agent.py --resume ${id}` }
}

function newSession(dir) {
  const cwd = SAFE_DIR.test(String(dir || '')) ? dir : '<agent folder>'
  return { ok: false, error: `Start one from a terminal: cd ${cwd} && python3 agent.py` }
}

const detect = () => exists(SESSIONS)

/**
 * A window of the agent's own transcript as the same blocks the Claude Code adapter hands
 * out, so the page renders both with one grammar. The agent writes one line per message:
 * user, assistant (text and/or tool_calls), and tool, the result, in call order.
 */
async function transcript(sessionId, { until = 0, since = -1, probe = false } = {}) {
  const id = String(sessionId || '')
  const file = UUID.test(id) ? path.join(SESSIONS, `${id}.jsonl`) : ''
  if (!file || !(await exists(file))) return { ok: false, error: 'No transcript on disk for that session' }
  if (probe) return { ok: true, end: (await fsp.stat(file)).size }
  const win = await readWindow(file, { until, since })
  const blocks = []
  const pending = [] // tool blocks still waiting for their result, in call order
  for (const m of jsonLines(win.text)) {
    if (m.role === 'user' && m.content) {
      blocks.push({ kind: 'user', text: String(m.content), ts: num(m.ts) })
    } else if (m.role === 'assistant') {
      if (m.content) blocks.push({ kind: 'text', text: String(m.content), ts: num(m.ts) })
      for (const call of m.tool_calls || []) {
        const fn = call?.function || {}
        const args = fn.arguments && typeof fn.arguments === 'object' ? fn.arguments : {}
        const line = String(args.path || args.command || args.code || args.query || Object.values(args)[0] || '')
        const full = JSON.stringify(args, null, 1)
        const block = {
          kind: 'tool',
          name: String(fn.name || 'tool'),
          line: line.slice(0, 140),
          full: full.length > 2400 ? `${full.slice(0, 2400)}…` : full,
          result: '',
          isError: false,
        }
        blocks.push(block)
        pending.push(block)
      }
    } else if (m.role === 'tool') {
      const block = pending.shift()
      if (block) block.result = String(m.content || '').slice(0, 4000)
    }
  }
  return { ok: true, blocks, until: win.start, more: since < 0 && win.start > 0, end: win.end }
}

/**
 * How to get a message to an agent, without doing it. A running agent is watching its inbox
 * (a file beside its card that it reads and deletes), so the answer is that file's path. One
 * that has ended needs a process: the command to start it, resuming the session. A fresh
 * session gets its id chosen here, so the page can follow the transcript from its first line.
 */
async function deliver({ sessionId, dir }) {
  const id = String(sessionId || '')
  if (id) {
    if (!UUID.test(id)) return { ok: false, error: 'Not a local-agent session' }
    const card = await readCard(path.join(SESSIONS, `${id}.json`))
    if (!card) return { ok: false, error: 'No card on disk for that session' }
    if (card.state !== 'ended' && alive(card.pid)) {
      // Only the file's name: writing it is the server's doing, so this stays read only.
      return { ok: true, mode: 'inbox', file: path.join(SESSIONS, `${id}.inbox`), sessionId: id }
    }
    const name = String(card.agent || path.basename(String(card.projectPath || '')))
    if (!/^[a-z0-9_-]+$/i.test(name)) return { ok: false, error: 'That session names no agent' }
    return { ok: true, mode: 'spawn', argv: ['python3', 'run.py', name, '--resume', id], cwd: WORKSHOP, sessionId: id }
  }
  // A fresh session in an agent folder (agents/<name>/, with its AGENT.md).
  const folder = String(dir || '')
  const name = path.basename(folder)
  if (!SAFE_DIR.test(folder) || !/^[a-z0-9_-]+$/i.test(name) || !(await exists(path.join(folder, 'AGENT.md')))) {
    return { ok: false, error: 'That folder is not an agent (no AGENT.md)' }
  }
  const fresh = randomUUID()
  return { ok: true, mode: 'spawn', argv: ['python3', 'run.py', name, '--resume', fresh], cwd: WORKSHOP, sessionId: fresh }
}

export default {
  id: 'local-agent',
  name: 'Local Agent',
  detect,
  scanThreads,
  openThread,
  newSession,
  transcript,
  deliver,
  paths: { SESSIONS },
}
