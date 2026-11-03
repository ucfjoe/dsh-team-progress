// dsh-team-progress — host half.
//
// One loopback JSON endpoint, /api/team-progress/rpc, with exactly one method:
//
//   state — four views of the team's live work, counted from durable state:
//           { ok, generatedAt, summary, roster, defects, goal, attention,
//             degraded:{ any, reasons } }
//
// THE FOUR VIEWS (0.2.0)
//
//   1. roster   — member → claimed shared task → task status, plus STALLED for a
//                 member that is not running while owning an in-progress task.
//                 `list_agents` gives name + running/inactive, and a member's
//                 `description` is fixed at spawn and drifts as work moves. The
//                 CLAIMED TASK is the durable truth of what a member is doing, so
//                 that is what this view joins on.
//   2. defects  — counts by status from configurable markdown defect logs, plus
//                 the rows still `open`. The path list comes from plugin config
//                 only; it is NEVER taken from the request (see TRANSPORT).
//   3. goal     — the session goal's objective, roundsStarted vs maxGoalRounds
//                 and phase. `no goal` when none is armed, which is different
//                 from an unreadable goal.
//   4. attention — blocked and stalled work, sorted stalled-first at the TOP of
//                 the rendered panel.
//
// WHY THE READ PATH IS SHAPED THIS WAY (verified 2026-10-24, dsh 0.2.1-rc.3)
//
//   * Team state is scoped to a LEAD. `listTasks(caller)` (:1546) and
//     `listMembers(caller)` (:1498) both resolve their caller through
//     `roster.membership(agent)` (:861), which throws unless the agent is a live
//     team member. The correct enumeration is therefore
//     `agents.roots()` (dsh-agent/lib/index.js:623 — `entry.owner === undefined`)
//     → one `tryMembership(lead)` per lead
//     (dsh-experimental-agent-team/lib/index.js:870-900)
//     → that lead's board.
//
//   * A member id is NOT a lookup key here. The earlier version resolved every
//     roster id through `agents.get(memberId)`; member ids belong to teammate
//     sessions that may never have been live in this process, so those lookups
//     returned undefined and the panel printed "<4> unknown" for boards it could
//     read perfectly well. `agents.get()` is not called at all in this file.
//
//   * `tryMembership` cannot distinguish "no team" from "team of one": it
//     returns a LEAD shape for any live root agent (:893-899). Team-ness is
//     therefore decided by evidence — a roster row with role "teammate", or at
//     least one task — and a lead with neither is skipped silently.
//
//   * The durable `agentTeam` projection stays as the fallback for the SAME lead
//     set, read via `sessionProjections.stateOf(lead.session, 'agentTeam')`
//     (dsh-session-projection/lib/index.js:126). It carries durable phase only
//     (`provisioning | active | failed`) and no live running/inactive, so stalls
//     are not computable on that path: `summary.stalled` and every roster row's
//     `stalled` are `null` there rather than a fabricated 0/false.
//
//   * The GOAL view reads the `goals` cordis service (0.2.0 addition). Its
//     contract, from the shipped dsh-goal package:
//         static inject = ['agents', 'sessionProjections']
//         get(agent) -> GoalView | undefined   // throws unless agent is LIVE
//     and `view()` returns `{ ...goal, roundsStarted, createdAt, updatedAt,
//     activation }` — so `roundsStarted` is NOT on GoalSnapshot itself. Note that
//     `get()` THROWS for an agent that is not the registry's live instance, which
//     is why every call is wrapped: a throw must read as "could not read", never
//     as "no goal".
//
//   * Nothing is estimated. Every number is a COUNT of durable state — board
//     tasks, claimed owners, goal rounds, defect-log rows. There is no ETA, no
//     elapsed time and no percentage.
//
//   * An absent source is never a zero. Each view carries its own
//     `state`/`reason`, so a missing defect log or an unregistered goal service
//     renders `unavailable: <reason>` instead of a confident 0. `degraded` keeps
//     its original, narrower meaning: the BOARD and TEAM read only. A missing
//     defect file does not make the task board degraded, so it does not raise
//     that flag — the defects view says so itself, in place.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'team-progress'

// webServer is the only hard injection. Resolving agentTeams / agents /
// sessionProjections / goals lazily keeps the panel loadable on a profile where
// the Agent Teams or goal bundle is disabled, where it honestly reports a
// missing source.
export const inject = ['webServer']

const ROUTE = '/api/team-progress/rpc'
const TEAM_PROJECTION_KEY = 'agentTeam'

// Which actions outlive the click. Creating a teammate spends model budget and
// adds a live agent; member-limit rewrites a config file on disk. Both are hard to
// undo by clicking again, unlike a task status or a wake. `actionPolicy:
// 'read-write'` refuses exactly these; `'all'` (the default) keeps every action
// reachable once `allowMutations` is on, so a profile written before this key
// existed behaves identically.
const DESTRUCTIVE_ACTIONS = new Set(['spawn', 'member-limit'])
const ACTION_POLICIES = new Set(['all', 'read-write'])

// No default defect log. The defects view is a reader of whatever log the
// profile names, and a machine-specific path baked in here would be wrong
// everywhere except the machine it was written on. Empty is the honest default:
// with no `defectLogs` config the view reports
// `unavailable: no defect-log paths are configured`, which is a real answer,
// not a fault.
const DEFAULT_DEFECT_LOGS = []

// Hard caps. The endpoint is an HTTP surface and the log is an arbitrary file, so
// neither is allowed to be unbounded.
const MAX_BODY_BYTES = 64 * 1024
const MAX_DEFECT_BYTES = 4 * 1024 * 1024
const MAX_DEFECT_ROWS = 5000
const MAX_OPEN_ROWS = 50
const MAX_METHOD_ECHO = 64

// A member in one of these states cannot make progress on a task it owns.
// `provisioning` is deliberately absent: it is a normal startup state, not a
// stall. `unknown` is absent because it cannot say anything either way.
const NOT_RUNNING = new Set(['inactive', 'failed'])

function reasonOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

/** Resolve an optional service without throwing when the context is unusual. */
function service(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

const isName = (value) => typeof value === 'string' && value !== ''
const isCount = (value) => typeof value === 'number' && Number.isFinite(value)

/** Roster status: the live values the Team service produces, else "unknown". */
function memberStatus(member) {
  const status = member && member.status
  if (status === 'running' || status === 'inactive' || status === 'provisioning' || status === 'failed') return status
  return 'unknown'
}

function labelOf(task) {
  if (task && isName(task.subject)) return task.subject
  return 'task ' + String(task && task.id)
}

/** Blocker ids that are missing or not yet completed. */
function unfinishedBlockers(task, byId) {
  const ids = task && Array.isArray(task.blockedBy) ? task.blockedBy : []
  return ids.filter((id) => {
    const blocker = byId.get(id)
    return blocker === undefined || blocker.status !== 'completed'
  })
}

function blockerDetail(ids) {
  if (ids.length === 0) return 'blocked'
  if (ids.length <= 2) return 'waiting on ' + ids.join(', ')
  return 'waiting on ' + ids.length + ' unfinished tasks'
}

// ===================== one board ============================================

/**
 * Count one lead's board.
 *
 * `blocked` is NOT a fourth durable status. The durable enum is
 * pending | in_progress | completed | deleted, and blocked is a derived property
 * of a PENDING task whose blocker has not completed (`taskReady`,
 * agent-team/lib/index.js:354). It is counted once, under `blocked`, and removed
 * from `pendingReady`, so the four counts stay disjoint and sum to `total`.
 *
 * `stalled` is the signal the shipped Agent Team popover cannot show: a task is
 * in progress but the member who owns it is not running. It needs LIVE member
 * status, so it is `null` (not 0) whenever statuses come from the durable
 * projection, and an owner that matches no roster row is never called stalled.
 *
 * @param tasks - current (non-deleted) task views.
 * @param members - live roster rows, `[]` for a known-empty roster, or null when the roster is unreadable.
 * @param liveStatus - true when `members` carries live running/inactive.
 */
function boardOf(tasks, members, liveStatus) {
  const rosterKnown = Array.isArray(members)
  const roster = rosterKnown ? members : []
  const byId = new Map(tasks.map((task) => [task.id, task]))

  const statusByName = new Map()
  if (rosterKnown && liveStatus) {
    for (const member of roster) {
      if (isName(member && member.name)) statusByName.set(member.name, memberStatus(member))
    }
  }

  let completed = 0
  let inProgress = 0
  let pendingReady = 0
  let blocked = 0
  let stalled = 0
  const attention = []

  for (const task of tasks) {
    if (task.status === 'completed') {
      completed += 1
      continue
    }
    if (task.status === 'in_progress') {
      inProgress += 1
      if (liveStatus && isName(task.ownerName)) {
        const status = statusByName.get(task.ownerName)
        if (status !== undefined && NOT_RUNNING.has(status)) {
          stalled += 1
          attention.push({
            kind: 'stalled',
            label: labelOf(task),
            detail: 'owner ' + task.ownerName + ' is ' + status,
          })
        }
      }
      continue
    }
    if (task.status !== 'pending') continue

    const ids = unfinishedBlockers(task, byId)
    // `ready` from the service is authoritative; the durable projection carries
    // no `ready`, so readiness is derived from blocker completion there.
    const isBlocked = typeof task.ready === 'boolean' ? task.ready === false : ids.length > 0
    if (isBlocked) {
      blocked += 1
      attention.push({ kind: 'blocked', label: labelOf(task), detail: blockerDetail(ids) })
    } else {
      pendingReady += 1
    }
  }

  return {
    total: tasks.length,
    completed,
    inProgress,
    pendingReady,
    blocked,
    // Stalls need both a live status AND a roster to match owners against; with
    // either missing this is null, because 0 would assert "nothing is stuck".
    stalled: liveStatus && rosterKnown ? stalled : null,
    liveStatus,
    members: {
      live: rosterKnown && liveStatus ? roster.filter((m) => memberStatus(m) === 'running').length : null,
      total: rosterKnown ? roster.length : null,
    },
    attention,
  }
}

/**
 * The board as lanes of cards, for a reader who wants to see the work rather than
 * count it. Same tasks, same owner names, same readiness rule as {@link boardOf} —
 * this is a second projection of one read, never a second read.
 *
 * Every lane is capped: a payload is not a database dump, and the answer to "what
 * is on the board" stays readable. `laneCounts` carries the true total beside the
 * capped rows, so a capped lane cannot be mistaken for a short one.
 */
const LANE_CAP = 12

function laneOf(task, byId) {
  const blockers = Array.isArray(task && task.blockedBy) ? task.blockedBy.map((id) => String(id)) : []
  return {
    id: String(task && task.id),
    subject: labelOf(task),
    owner: isName(task && task.ownerName) ? task.ownerName : null,
    status: String(task && task.status),
    revision: Number.isSafeInteger(task && task.revision) ? task.revision : null,
    // Why a card sits where it sits: the dependencies it declared, and whether the
    // domain itself called it ready. A card whose text says "blocked" but which
    // declares no dependency is not blocked — it is prose.
    blockedBy: blockers,
    ready: typeof (task && task.ready) === 'boolean' ? task.ready : null,
  }
}

function lanesOf(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const lanes = { ready: [], inProgress: [], done: [], blocked: [] }
  for (const task of tasks) {
    if (task.status === 'completed') lanes.done.push(laneOf(task, byId))
    else if (task.status === 'in_progress') lanes.inProgress.push(laneOf(task, byId))
    else if (task.status === 'pending') {
      const ids = unfinishedBlockers(task, byId)
      const isBlocked = typeof task.ready === 'boolean' ? task.ready === false : ids.length > 0
      if (isBlocked) lanes.blocked.push(laneOf(task, byId))
      else lanes.ready.push(laneOf(task, byId))
    }
  }
  const counts = {}
  const capped = {}
  for (const key of Object.keys(lanes)) {
    counts[key] = lanes[key].length
    capped[key] = lanes[key].slice(0, LANE_CAP)
  }
  return { lanes: capped, laneCounts: counts }
}

/** A board that exists but could not be counted: counts are null, never 0. */
function limitsOf(teamSvc) {
  return {
    members: teamSvc !== undefined && teamSvc.config !== undefined && Number.isSafeInteger(teamSvc.config.maxMembers)
      ? teamSvc.config.maxMembers
      : null,
  }
}

function unreadableBoard(roster) {
  const known = Array.isArray(roster)
  return {
    total: null,
    completed: null,
    inProgress: null,
    pendingReady: null,
    blocked: null,
    stalled: null,
    liveStatus: known,
    members: {
      live: known ? roster.filter((m) => memberStatus(m) === 'running').length : null,
      total: known ? roster.length : null,
    },
    attention: [],
  }
}

// ===================== view 1: roster =======================================

// When a member owns more than one task, the row reports the one it is most
// likely to be working on, and `claimed` still tells the whole truth.
const CLAIM_RANK = { in_progress: 0, pending: 1, completed: 2 }

/**
 * One row per member: what it claims, and whether that claim is stuck.
 *
 * `task: null` is a REAL absence — the member has claimed nothing — and is
 * rendered as "no claimed task", never as a zero count.
 *
 * `stalled` is `null` when live status is unavailable: the durable projection
 * knows the claim but not whether the owner is running, so both `true` and
 * `false` would be fabrication there.
 */
function rosterOf(tasks, members, liveStatus, leadId) {
  if (!Array.isArray(members)) return null

  const byOwner = new Map()
  for (const task of tasks) {
    if (!isName(task.ownerName)) continue
    const owned = byOwner.get(task.ownerName)
    if (owned === undefined) byOwner.set(task.ownerName, [task])
    else owned.push(task)
  }

  const rows = []
  for (const member of members) {
    if (!isName(member && member.name)) continue
    const owned = (byOwner.get(member.name) || []).slice().sort((a, b) => {
      const left = CLAIM_RANK[a.status] === undefined ? 9 : CLAIM_RANK[a.status]
      const right = CLAIM_RANK[b.status] === undefined ? 9 : CLAIM_RANK[b.status]
      return left - right
    })
    const claimed = owned.length > 0 ? owned[0] : null
    const status = memberStatus(member)
    rows.push({
      leadId,
      id: isName(member.id) ? member.id : null,
      name: member.name,
      role: member.role === 'lead' ? 'lead' : 'teammate',
      status,
      claimed: owned.length,
      taskId: claimed === null ? null : claimed.id,
      taskRevision: claimed === null ? null : Number.isSafeInteger(claimed.revision) ? claimed.revision : null,
      taskSubject: claimed === null ? null : isName(claimed.subject) ? claimed.subject : null,
      taskStatus: claimed === null ? null : claimed.status,
      stalled: stallOf(status, claimed, liveStatus),
    })
  }
  return rows
}

/**
 * Is this member stuck on what it claims?
 *
 *   null  — cannot say: no live status, or a roster row with no status at all.
 *   false — running, or nothing claimed, or the claim is not in progress.
 *   true  — not running while owning an in-progress task.
 *
 * `provisioning` is NOT a stall: it is the normal startup state, and treating it
 * as stuck made a healthy spawn look like a failure.
 */
function stallOf(status, claimed, liveStatus) {
  if (!liveStatus || status === 'unknown') return null
  if (claimed === null || claimed.status !== 'in_progress') return false
  return NOT_RUNNING.has(status)
}

/**
 * Aggregate per-lead rosters.
 *
 * The distinction that matters: a roster whose CLAIMS are readable but whose
 * running/inactive column is not is `partial`, not `ok` — the member rows are
 * real, the stall signal is missing. Anything pushed onto `reasons` here is also
 * returned separately so the caller can fold it into `degraded`.
 */
function mergeRoster(rosters, reasons) {
  const readable = rosters.filter((rows) => rows !== null)
  if (readable.length === 0) {
    return { state: 'unavailable', reason: 'the member roster could not be read', members: [] }
  }
  const notes = []
  if (readable.length !== rosters.length) {
    notes.push('part of the member roster could not be read')
    reasons.push('part of the member roster could not be read')
  }

  const members = []
  for (const rows of readable) for (const row of rows) members.push(row)

  const leads = new Set(members.filter((row) => row.role === 'lead').map((row) => row.leadId))
  const stalled = members.filter((row) => row.stalled === true).length
  const base = { members, leads: leads.size, stalled }

  if (members.length === 0) return { state: 'ok', ...base, notes }
  if (members.some((row) => row.stalled === null)) {
    notes.push('live member status unavailable')
    return { state: 'partial', reason: 'live member status unavailable', ...base, stalled: null, notes }
  }
  return { state: 'ok', ...base, notes }
}

// ===================== view 2: defect logs ==================================

// The documented vocabulary of the defect log — nothing invented, and anything
// else is counted as `other` so a new status can never silently disappear.
// The four documented states. `closed as superseded` carries the document's own
// tail (", not merged") — the phrase is cut before matching, so the tail does not
// change the state.
const STATUS_ALIASES = [
  ['in flight', 'inFlight'],
  ['in-flight', 'inFlight'],
  ['fixed', 'fixed'],
  ['open', 'open'],
  ['closed as superseded', 'superseded'],
]

function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split a markdown table row into trimmed cells, honouring `\|` escapes. */
function cellsOf(line) {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let cell = ''
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]
    if (char === '\\' && inner[i + 1] === '|') {
      cell += '|'
      i += 1
      continue
    }
    if (char === '|') {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  return cells
}

const isSeparatorCell = (cell) => /^:?-{2,}:?$/.test(cell)

/** Index of the first non-blank line at or after `from`, or -1. */
function nextNonBlank(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    if ((lines[i] || '').trim() !== '') return i
  }
  return -1
}

/**
 * Resolve a status cell to one of the FOUR documented states.
 *
 * The document owns the vocabulary; this panel does not grow a bucket for every
 * phrasing it meets. The states are `open` / `in flight` / `fixed` /
 * `superseded`, and anything else is counted as `other` rather than being
 * guessed at — a phrasing the document has not settled on should look unsettled.
 *
 * A status cell carries prose after the state (`**fixed** #222 — …`,
 * `**open** — task-17`, `**closed as superseded, not merged** — …`), so the cell
 * is cut at the first punctuation that ends the state phrase. Cutting at `#`
 * also keeps `fixed #257 @ 52de5b4 (merge commit …)` from being read as anything
 * but `fixed`.
 */
function normalizeStatus(cell) {
  const bold = /\*\*([^*\n]+)\*\*/.exec(cell)
  const raw = (bold === null ? cell : bold[1]).replace(/[*_`]/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ')
  const phrase = raw.split(/[,;:—–(#]|\s-\s/)[0].trim()
  for (const [alias, value] of STATUS_ALIASES) {
    if (phrase === alias) return value
  }
  return 'other'
}

function columnIndexOf(header, pattern) {
  for (let i = 0; i < header.length; i += 1) {
    if (pattern.test(header[i].replace(/[*_`]/g, '').trim().toLowerCase())) return i
  }
  return -1
}

function isDefectHeader(cells) {
  const status = columnIndexOf(cells, /^status$/)
  const defect = columnIndexOf(cells, /defect|issue|problem|bug/)
  return status !== -1 && defect !== -1
}

/**
 * Every row of every `# | Defect | Evidence | Status` table in one markdown file.
 *
 * Section headings are carried on each row: "Blocked the investigation" and
 * "Wrong output, not yet blocking" are different urgencies of the same status.
 */
function scanDefectTables(text) {
  const lines = text.split(/\r?\n/)
  const rows = []
  let section = null
  let i = 0

  while (i < lines.length) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(lines[i])
    if (heading !== null) {
      section = cleanText(heading[1])
      i += 1
      continue
    }
    const header = cellsOf(lines[i])
    const separator = header === null ? null : cellsOf(lines[i + 1] || '')
    if (header !== null && isDefectHeader(header) && separator !== null && separator.every(isSeparatorCell)) {
      const refIdx = columnIndexOf(header, /^#|^no\.?$|^ref$/)
      const defectIdx = columnIndexOf(header, /defect|issue|problem|bug/)
      const evidenceIdx = columnIndexOf(header, /evidence|detail|proof/)
      const statusIdx = columnIndexOf(header, /^status$/)
      i += 2
      while (i < lines.length && rows.length < MAX_DEFECT_ROWS) {
        let cells = cellsOf(lines[i])
        if (cells === null && (lines[i] || '').trim() === '') {
          // A BLANK line does not reliably end a table in practice: the live
          // defect log separates rows of ONE table with blank lines, and breaking
          // there silently dropped 4 of its 32 entries. A count that disagrees
          // with the document is the exact defect class this panel exists to
          // avoid, so blanks are transparent while the next non-blank line is
          // still a data row. A heading, separator, new header or prose ends it.
          const next = nextNonBlank(lines, i + 1)
          const resumed = next === -1 ? null : cellsOf(lines[next])
          if (resumed !== null && !isDefectHeader(resumed) && !resumed.every(isSeparatorCell)) {
            i = next
            cells = resumed
          }
        }
        if (cells === null) break
        const defect = cleanText(cells[defectIdx] || '')
        const evidence = evidenceIdx === -1 ? '' : cleanText(cells[evidenceIdx] || '')
        if (defect !== '' || evidence !== '') {
          rows.push({
            ref: refIdx === -1 ? '' : cleanText(cells[refIdx] || ''),
            defect,
            evidence,
            status: normalizeStatus(cells[statusIdx] || ''),
            section,
          })
        }
        i += 1
      }
      continue
    }
    i += 1
  }
  return rows
}

// Re-reading a small file on every 5s poll is wasteful, so the parsed result is
// cached against the file's own mtime+size. An unchanged file costs one stat.
const defectCache = new Map()

function readDefectFile(filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (error) {
    return { state: 'unavailable', reason: reasonOf(error) }
  }
  if (!stat.isFile()) return { state: 'unavailable', reason: 'not a regular file' }
  if (stat.size > MAX_DEFECT_BYTES) {
    return { state: 'unavailable', reason: 'file is larger than ' + MAX_DEFECT_BYTES + ' bytes' }
  }
  const cached = defectCache.get(filePath)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return { state: 'unavailable', reason: reasonOf(error) }
  }
  const result = { state: 'ok', rows: scanDefectTables(text) }
  defectCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result })
  return result
}

function expandHome(filePath) {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2))
  return filePath
}

function emptyCounts() {
  return { fixed: 0, inFlight: 0, open: 0, superseded: 0, other: 0, total: 0 }
}

/**
 * Counts by status across every configured log, plus the rows still open.
 *
 * A file that cannot be read contributes no rows and is reported by name — the
 * aggregate is then `partial`, and only an aggregate with NO readable file at
 * all is `unavailable` with `counts: null`. A zero here always means "zero rows
 * were counted", never "the file was missing".
 */
function readDefects(configuredPaths) {
  const paths = Array.isArray(configuredPaths) ? configuredPaths : []
  if (paths.length === 0) {
    return { state: 'unavailable', reason: 'no defect-log paths are configured', files: [], counts: null, open: [] }
  }

  const files = []
  const counts = emptyCounts()
  const open = []
  let readable = 0

  for (const filePath of paths) {
    const read = readDefectFile(filePath)
    if (read.state !== 'ok') {
      files.push({ path: filePath, state: 'unavailable', reason: read.reason, rows: null })
      continue
    }
    readable += 1
    for (const row of read.rows) {
      counts[row.status] += 1
      counts.total += 1
      if (row.status === 'open' && open.length < MAX_OPEN_ROWS) open.push({ ...row, file: filePath })
    }
    files.push({ path: filePath, state: 'ok', rows: read.rows.length })
  }

  if (readable === 0) {
    const first = files.length > 0 ? files[0].reason : 'no defect log could be read'
    return { state: 'unavailable', reason: first, files, counts: null, open: [] }
  }

  const openCount = counts.open
  const truncated = openCount > open.length ? openCount - open.length : 0
  const result = {
    state: readable === paths.length ? 'ok' : 'partial',
    files,
    counts,
    open,
    openShown: open.length,
    openTruncated: truncated,
  }
  if (readable !== paths.length) {
    const missing = files.filter((file) => file.state !== 'ok').length
    result.reason = missing + ' of ' + paths.length + ' defect logs could not be read'
  }
  return result
}

// ===================== view 3: goal =========================================

const GOAL_PHASES = new Set(['active', 'paused', 'blocked', 'complete'])

function goalRowOf(view, leadId) {
  return {
    leadId,
    objective: typeof view.objective === 'string' && view.objective !== '' ? view.objective : null,
    phase: GOAL_PHASES.has(view.phase) ? view.phase : null,
    // `roundsStarted` is the highest admitted round number, so it is a COUNT of
    // rounds begun. Absent means unreadable, which is null rather than 0.
    roundsStarted: isCount(view.roundsStarted) ? view.roundsStarted : null,
    maxGoalRounds: isCount(view.maxGoalRounds) ? view.maxGoalRounds : null,
    // `armed` vs `disarmed` is process-local continuation authority: a goal can
    // be `active` and `disarmed` at once (after a resume-less restart).
    activation: view.activation === 'armed' || view.activation === 'disarmed' ? view.activation : null,
    ...(typeof view.blockedReason === 'string' && view.blockedReason !== '' ? { blockedReason: view.blockedReason } : {}),
  }
}

/**
 * Read each lead's goal.
 *
 * `goals.get(agent)` THROWS when the agent is not the registry's live instance,
 * so every call is wrapped. The three outcomes stay distinct:
 *   ok          — at least one goal was read.
 *   none        — every lead answered AND none had a goal ("no goal", not 0).
 *   unavailable — a read failed and no goal was found; we cannot claim "none".
 */
function readGoal(goalsSvc, leads) {
  if (goalsSvc === undefined) {
    return { state: 'unavailable', reason: 'the goal service is not registered on this profile', goals: [] }
  }
  if (typeof goalsSvc.get !== 'function') {
    return { state: 'unavailable', reason: 'the goal service has no get() reader', goals: [] }
  }

  const goals = []
  const failures = []
  let answered = 0

  for (const lead of leads) {
    if (!lead || !isName(lead.id)) continue
    let view
    try {
      view = goalsSvc.get(lead)
      answered += 1
    } catch (error) {
      failures.push(reasonOf(error))
      continue
    }
    if (view !== undefined && view !== null) goals.push(goalRowOf(view, lead.id))
  }

  if (goals.length > 0) return { state: 'ok', goals }
  if (failures.length > 0) {
    return { state: 'unavailable', reason: 'the goal could not be read: ' + failures[0], goals: [] }
  }
  // Every lead answered and none had a goal. That is "no goal", and it is NOT
  // the same thing as a read that failed.
  return { state: 'none', goals: [], ...(answered === 0 ? { reason: 'no lead session exists to own a goal' } : {}) }
}

// ===================== durable projection ===================================

function leadIdOf(lead) {
  return lead && isName(lead.id) ? lead.id : null
}

/** Roster rows from the durable projection. Phase is NOT live status. */
function membersFromState(state, lead) {
  const leadId = leadIdOf(lead)
  const members = [
    { id: leadId, name: 'lead', role: 'lead', status: 'unknown', statusSource: 'projection' },
  ]
  for (const member of state.members || []) {
    members.push({
      id: member.id,
      name: member.name,
      role: 'teammate',
      status: member.phase === 'failed' ? 'failed' : member.phase === 'provisioning' ? 'provisioning' : 'unknown',
      statusSource: 'projection',
    })
  }
  return members
}

/** Task views from the durable projection, with owner names and readiness derived. */
function tasksFromState(state, lead) {
  const leadId = leadIdOf(lead)
  const nameById = new Map()
  for (const member of state.members || []) nameById.set(member.id, member.name)
  return (state.tasks || [])
    .filter((task) => task.status !== 'deleted')
    .map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      blockedBy: [...(task.blockedBy || [])],
      ...(task.ownerId === undefined
        ? {}
        : { ownerName: task.ownerId === leadId ? 'lead' : nameById.get(task.ownerId) || 'unresolved member' }),
    }))
}

// ===================== one lead =============================================

/**
 * Read one lead's board, preferring the live service and falling back to the
 * durable projection for the SAME lead.
 *
 * @returns `{ board, roster, reasons }`, or null when this lead has no team at all.
 */
function readLead(lead, teamSvc, projections, force) {
  if (!lead || !isName(lead.id)) return null
  const reasons = []
  let roster = null
  let rosterHasTeam = false

  if (teamSvc !== undefined) {
    // One membership lookup per lead — the only identity resolution performed.
    let membership
    try {
      membership = teamSvc.tryMembership(lead)
    } catch {
      membership = undefined
    }
    if (membership !== undefined && membership !== null && membership.role !== 'lead') return null
    const caller = membership && membership.root ? membership.root : lead

    try {
      roster = teamSvc.listMembers(caller)
    } catch {
      roster = null
    }
    if (Array.isArray(roster)) rosterHasTeam = roster.some((member) => member && member.role === 'teammate')

    let rawTasks
    try {
      rawTasks = teamSvc.listTasks(caller)
    } catch {
      rawTasks = null
    }
    if (Array.isArray(rawTasks)) {
      const tasks = rawTasks.filter((task) => task && task.status !== 'deleted')
      // No teammates and no tasks is an ordinary conversation — UNLESS this session
      // is a Team Lead, in which case it owns a (possibly empty) team and the
      // per-session tab has to be able to show it.
      // An ordinary conversation is not a team. A session's own tab asks for its
      // team explicitly (`force`), and may then get an empty board back.
      if (tasks.length === 0 && !rosterHasTeam && !force) return null
      // Counts are real but the roster is not: say so rather than silently
      // dropping the member half of the summary line.
      if (!Array.isArray(roster)) reasons.push('live member status unavailable')
      return {
        board: boardOf(tasks, roster, true),
        roster: rosterOf(tasks, roster, true, leadIdOf(lead)),
        ...lanesOf(tasks),
        reasons,
      }
    }
    // Deliberately NOT recorded here: the durable projection below may still
    // read this board, and "could not be read" would then contradict the counts.
  }

  if (projections !== undefined) {
    let state
    let projectionFailed = false
    try {
      state = projections.stateOf(lead.session, TEAM_PROJECTION_KEY)
    } catch {
      projectionFailed = true
      state = undefined
    }
    if (state !== undefined && state !== null) {
      if (state.failure !== undefined) reasons.push('the durable team record was rejected')
      const tasks = tasksFromState(state, lead)
      const hasMembers = (state.members || []).length > 0
      if (tasks.length === 0 && !hasMembers && !rosterHasTeam) return null
      // A live roster (when the service read it before the board failed) is
      // strictly better than durable phase, so it is preferred when present.
      const live = Array.isArray(roster)
      if (!live) reasons.push('live member status unavailable')
      const members = live ? roster : membersFromState(state, lead)
      return {
        board: boardOf(tasks, members, live),
        roster: rosterOf(tasks, members, live, leadIdOf(lead)),
        ...lanesOf(tasks),
        reasons,
      }
    }
    if (projectionFailed) reasons.push('the durable team record could not be read')
    else if (teamSvc !== undefined) reasons.push('the durable team record is not registered')
  }

  // Neither source produced a board. Report the hole only when the roster proves
  // a team exists — otherwise this was simply not a team run.
  if (rosterHasTeam) {
    if (!reasons.includes('the task board could not be read')) reasons.push('the task board could not be read')
    return { board: unreadableBoard(roster), roster: null, lanes: null, laneCounts: null, reasons }
  }
  return null
}

// ===================== summary ==============================================

function nullSummary() {
  return {
    total: null,
    completed: null,
    inProgress: null,
    pendingReady: null,
    blocked: null,
    stalled: null,
    members: { live: null, total: null },
  }
}

/**
 * Aggregate per-Lead boards into the one summary the panel prints.
 *
 * A partly unreadable board keeps the counts it does have and discloses the hole
 * in one short reason; only a board set with nothing readable yields nulls.
 */
function summarize(boards) {
  const reasons = new Set()
  const counted = boards.filter((board) => board.total !== null)
  const allCounted = boards.length === 0 || counted.length === boards.length
  // Only the PARTIAL case needs a reason of its own: when nothing was readable,
  // readLead already said "the task board could not be read", and two
  // near-identical strings would be noise on a glanceable panel.
  if (counted.length > 0 && !allCounted) reasons.add('part of the task board is unreadable')

  const sum = (pick) => {
    if (!allCounted) return null
    return counted.reduce((total, board) => total + pick(board), 0)
  }

  const membersTotalKnown = boards.every((board) => board.members.total !== null)
  const membersLiveKnown =
    membersTotalKnown &&
    boards.every((board) => board.members.live !== null) &&
    boards.every((board) => board.liveStatus === true)
  if (!membersLiveKnown && boards.length > 0 && membersTotalKnown) reasons.add('live member status unavailable')

  const stalledKnown = boards.every((board) => board.stalled !== null)

  const summary = {
    total: sum((board) => board.total),
    completed: sum((board) => board.completed),
    inProgress: sum((board) => board.inProgress),
    pendingReady: sum((board) => board.pendingReady),
    blocked: sum((board) => board.blocked),
    stalled: stalledKnown ? boards.reduce((total, board) => total + board.stalled, 0) : null,
    members: {
      live: membersLiveKnown ? boards.reduce((total, board) => total + board.members.live, 0) : null,
      total: membersTotalKnown ? boards.reduce((total, board) => total + board.members.total, 0) : null,
    },
  }

  // Stalled first: it is the one thing the existing Agent Team UI cannot show.
  const stalled = []
  const blocked = []
  for (const board of boards) {
    for (const item of board.attention) {
      if (item.kind === 'stalled') stalled.push(item)
      else blocked.push(item)
    }
  }

  return { summary, attention: [...stalled, ...blocked], reasons: [...reasons] }
}

// ===================== what needs a human ===================================

/**
 * The question an Overview pane exists to answer, from durable state only.
 *
 *  - `stalled`    a teammate holds an `in_progress` task and is not running, so
 *                 the Lead has to answer or unblock it.
 *  - `unassigned` a `ready` task nobody holds, so the Lead has to hand it out.
 *  - `idle`       teammates standing by while ready work exists. Context for
 *                 `unassigned`, and deliberately NOT added into `total`: one
 *                 ready task with three idle teammates is one thing to do.
 *
 * Three-valued for the reason the rest of this payload is: "nothing needs you"
 * and "I could not see" must never print the same number.
 */
function waitingOnYouOf(roster, lanes) {
  const members = roster && Array.isArray(roster.members) ? roster.members : null
  const ready = lanes && Array.isArray(lanes.ready) ? lanes.ready : null
  if (members === null) {
    return { state: 'unavailable', total: null, stalled: null, unassigned: null, idle: null }
  }
  const liveKnown = members.every((member) => member && typeof member.stalled === 'boolean')
  const stalled = liveKnown ? members.filter((member) => member && member.stalled === true).length : null
  const unassigned = ready === null ? null : ready.filter((task) => task && task.owner === null).length
  const idle = liveKnown
    ? members.filter(
        (member) =>
          member &&
          member.role === 'teammate' &&
          member.status === 'inactive' &&
          (Number.isSafeInteger(member.claimed) ? member.claimed : 0) === 0,
      ).length
    : null
  const total = stalled === null || unassigned === null ? null : stalled + unassigned
  return { state: total === null ? 'partial' : 'ok', total, stalled, unassigned, idle }
}

/** Fold per-card counts into the one the headline prints. */
function mergeWaitingOnYou(cards) {
  const rows = cards.map((card) => card && card.waitingOnYou).filter((row) => row && row.total !== null)
  const empty = { total: null, stalled: null, unassigned: null, idle: null }
  if (rows.length === 0) {
    return { state: cards.length === 0 ? 'ok' : 'unavailable', ...empty }
  }
  const sum = (key) => (rows.every((row) => row[key] !== null) ? rows.reduce((total, row) => total + row[key], 0) : null)
  const total = sum('total')
  return {
    state: rows.length === cards.length && total !== null ? 'ok' : 'partial',
    total,
    stalled: sum('stalled'),
    unassigned: sum('unassigned'),
    idle: sum('idle'),
  }
}

// ===================== lineage ==============================================

/**
 * How many sessions hang off one coordinator.
 *
 * The three kinds are counted apart because they mean different things:
 *
 *  - `forks`     `isSeeded: true` and no `origin` — a session forked from this
 *                one, so it starts with an inherited event prefix.
 *  - `subagents` `origin: 'subagent'` — delegated work that reports back.
 *  - `other`     a child carrying neither marker. Counted, never guessed at.
 *
 * The sum is the cheapest honest signal that one conversation is carrying more
 * than a conversation: a Lead whose session has sixty branches does not need a
 * better sidebar, it needs threads.
 */
async function lineageOf(sessionQuery, leadId, extras = {}) {
  const unavailable = (reason) => ({
    state: 'unavailable',
    reason,
    forks: null,
    subagents: null,
    other: null,
    branches: null,
    children: [],
    rows: [],
    truncated: false,
    rowState: 'unavailable',
  })
  if (!isName(leadId)) return unavailable('the lead has no session identity')
  if (sessionQuery === undefined || typeof sessionQuery.filterSessions !== 'function') {
    return unavailable('the session store is not registered')
  }
  let children
  try {
    children = await sessionQuery.filterSessions([{ kind: 'parent', values: [leadId] }])
  } catch {
    return unavailable('the session store could not be read')
  }
  if (!Array.isArray(children)) return unavailable('the session store returned no rows')
  let forks = 0
  let subagents = 0
  let other = 0
  for (const child of children) {
    const header = child && child.header ? child.header : {}
    if (header.origin === 'subagent') subagents += 1
    else if (header.isSeeded === true) forks += 1
    else other += 1
  }
  const branches = forks + subagents + other
  const block = await branchRowsOf(children, extras)
  return {
    state: 'ok',
    forks,
    subagents,
    other,
    branches,
    // Both names carry the same array: the board task calls the field `children`,
    // and the client half reads `rows`. Emitting one alias is cheaper than a
    // consumer that silently finds nothing.
    children: block.rows,
    rows: block.rows,
    truncated: branches > block.rows.length,
    rowState: block.rowState,
    ...(block.reason === undefined ? {} : { reason: block.reason }),
  }
}

/** Most branch rows one card carries. The chip says "showing N of M" beyond this. */
const MAX_BRANCH_ROWS = 20

/**
 * Reading more than this many children per card is not worth a poll. The counts
 * stay exact either way; only the row list is bounded.
 */
const MAX_BRANCH_SCAN = 200

/** A durable session id is `session-<uuid>`; the short form drops the prefix. */
function shortSessionId(id) {
  return String(id === undefined || id === null ? '' : id).replace(/^session-/, '').slice(0, 8)
}

/**
 * The child sessions behind the `N branches` chip.
 *
 * LABELS COME FROM THE PROJECTION CACHE, NOT FROM A TITLE FOLD. The fold
 * (`sessionQuery.readTitleSnapshots`) answers "no title" for every session in
 * this profile — measured, and it is why a sibling panel printed bare session
 * ids for 120 rows. `sessionProjectionCache.cachedSnapshot(header, ['title'])`
 * reads the same materialized cell the shipped sidebar lists, so a card names a
 * branch the way the sidebar does.
 *
 * SIBLINGS SHARE TRUNCATED TITLES. The projection truncates a long title to a
 * fixed prefix, so three distinct forks can all read "Build a new local DSH".
 * Duplicates therefore get a 4-character id suffix and are marked
 * `title+disambiguated` — a row that cannot be told apart from its siblings is
 * not a usable row.
 *
 * A row whose label could not be read prints its short id and says so with
 * `labelSource: 'session-id'`; it never prints "blank".
 * @param {object[]} children - `filterSessions` rows for one lead.
 * @param {object} extras - `{ projectionCache, agents, now }`.
 * @returns {Promise<{ rows: object[], rowState: string, reason?: string }>} the rows.
 */
async function branchRowsOf(children, extras) {
  const now = typeof extras.now === 'number' ? extras.now : Date.now()
  const projectionCache = extras.projectionCache
  const agents = extras.agents

  const running = new Set()
  try {
    const list = agents !== undefined && agents !== null && typeof agents.list === 'function' ? agents.list() : []
    for (const agent of Array.isArray(list) ? list : []) {
      const id = agent !== null && agent !== undefined && agent.session !== undefined ? agent.session.id : undefined
      if (typeof id === 'string' && agent.status === 'running') running.add(id)
    }
  } catch {
    /* an unreadable registry only removes the running dot */
  }

  const scanned = []
  let unreadable = 0
  for (const child of children.slice(0, MAX_BRANCH_SCAN)) {
    const header = child !== null && child !== undefined ? child.header : undefined
    if (header === undefined || header === null || typeof header.id !== 'string' || header.id === '') continue
    let title
    if (projectionCache !== undefined && projectionCache !== null && typeof projectionCache.cachedSnapshot === 'function') {
      try {
        const snapshot = projectionCache.cachedSnapshot(header, ['title'])
        const value = snapshot !== null && snapshot !== undefined && snapshot.values !== undefined ? snapshot.values.title : undefined
        if (typeof value === 'string' && value.trim() !== '') title = value.trim()
      } catch {
        unreadable += 1
      }
    }
    scanned.push({ header, title })
  }

  // Duplicate detection spans every scanned child, not just the rows that fit,
  // so the first 20 rows are disambiguated against siblings that sort later.
  const seen = new Map()
  for (const entry of scanned) {
    if (entry.title === undefined) continue
    seen.set(entry.title, (seen.get(entry.title) ?? 0) + 1)
  }

  const rows = scanned.slice(0, MAX_BRANCH_ROWS).map((entry) => {
    const header = entry.header
    const id = header.id
    const shared = entry.title !== undefined && seen.get(entry.title) > 1
    const label =
      entry.title === undefined ? 'session ' + shortSessionId(id) : shared ? entry.title + ' · ' + id.slice(-4) : entry.title
    return {
      sessionId: id,
      label,
      labelSource: entry.title === undefined ? 'session-id' : shared ? 'title+disambiguated' : 'title',
      // Three-valued, same rule as everywhere else in this panel: a row with no
      // label is not evidence the session is empty, so it is not called blank
      // when the cache could not be read at all.
      state: running.has(id) ? 'running' : entry.title === undefined ? (unreadable > 0 ? 'unlabeled' : 'blank') : 'inactive',
      ageSeconds: typeof header.createdAt === 'number' ? Math.max(0, Math.floor((now - header.createdAt) / 1000)) : null,
    }
  })

  return {
    rows,
    rowState: rows.length === 0 ? 'none' : 'ok',
    ...(unreadable === 0 ? {} : { reason: unreadable + ' branch title(s) could not be read' }),
  }
}

// ===================== snapshot ============================================

async function buildState(ctx, now, config, focusSessionId) {
  const reasons = new Set()
  const agents = service(ctx, 'agents')
  const projections = service(ctx, 'sessionProjections')
  const teamSvc = service(ctx, 'agentTeams')
  const goalsSvc = service(ctx, 'goals')
  const sessionQuery = service(ctx, 'sessionQuery')

  if (teamSvc === undefined && projections === undefined) {
    reasons.add('Agent Teams is not available on this profile')
  }

  const payload = (summary, attention, roster, defects, goal) => ({
    ok: true,
    generatedAt: now,
    summary,
    roster,
    defects,
    goal,
    attention,
    actions: { enabled: config.allowMutations === true, policy: config.actionPolicy === 'read-write' ? 'read-write' : 'all' },
    teams: [],
    // A degraded read still has to answer the question, so it answers "I could
    // not see" rather than omitting the field the panel asks for.
    waitingOnYou: { state: 'unavailable', total: null, stalled: null, unassigned: null, idle: null },
    degraded: { any: reasons.size > 0, reasons: [...reasons] },
  })

  // The defect view does not depend on any DSH service, so it is read even when
  // the agent registry is missing.
  const defects = () => readDefects(config.defectLogs)

  if (agents === undefined) {
    reasons.add('the agent registry is not registered')
    const degraded = payload(nullSummary(), [], { state: 'unavailable', reason: 'the agent registry is not registered', members: [] }, defects(), {
      state: 'unavailable',
      reason: 'the agent registry is not registered',
      goals: [],
    })
    degraded.limits = limitsOf(teamSvc)
    return degraded
  }

  let leads
  try {
    const value = agents.roots()
    leads = Array.isArray(value) ? value : []
  } catch (error) {
    reasons.add('the live lead list could not be read: ' + reasonOf(error))
    const degraded = payload(nullSummary(), [], { state: 'unavailable', reason: 'the live lead list could not be read', members: [] }, defects(), {
      state: 'unavailable',
      reason: 'the live lead list could not be read',
      goals: [],
    })
    degraded.limits = limitsOf(teamSvc)
    return degraded
  }

  const boards = []
  const rosters = []
  const perLead = []
  let sawTeam = false
  for (const lead of leads) {
    let read
    try {
      read = readLead(lead, teamSvc, projections, focusSessionId !== undefined && leadIdOf(lead) === focusSessionId)
    } catch {
      read = null
    }
    if (read === null) continue
    sawTeam = true
    for (const reason of read.reasons) reasons.add(reason)
    boards.push(read.board)
    rosters.push(read.roster)
    perLead.push({ lead, board: read.board, roster: read.roster, lanes: read.lanes, laneCounts: read.laneCounts })
  }

  const memberLimit = teamSvc !== undefined && teamSvc.config !== undefined && Number.isSafeInteger(teamSvc.config.maxMembers)
    ? teamSvc.config.maxMembers
    : null
  const result = summarize(boards)
  // Roster first: mergeRoster adds to `result.reasons`, so those reasons must be
  // folded into the set AFTER it runs, not before.
  const roster = sawTeam
    ? mergeRoster(rosters, result.reasons)
    : { state: 'ok', members: [], leads: 0, stalled: 0 }
  for (const reason of result.reasons) reasons.add(reason)

  // One read per lead, batched before the card map so the map stays synchronous
  // and a single slow store listing cannot serialise the whole panel.
  const lineageByLead = new Map()
  await Promise.all(
    perLead.map(async (entry) => {
      const leadId = leadIdOf(entry.lead)
      lineageByLead.set(
        leadId,
        await lineageOf(sessionQuery, leadId, {
          projectionCache: service(ctx, 'sessionProjectionCache'),
          agents,
          now,
        }),
      )
    }),
  )

  // One card per Team. A profile can run unrelated teams at once — the flat
  // aggregate above cannot say whose task a row belongs to, and a Lead picking
  // an action needs to know which team it acts on.
  const built0 = perLead.map((entry) => {
    const one = summarize([entry.board])
    const merged = mergeRoster([entry.roster], one.reasons)
    const goal = readGoal(goalsSvc, [entry.lead])
    const dormant = one.summary.total === 0 && (one.summary.members.live === 0 || one.summary.members.live === null)
    const leadId = leadIdOf(entry.lead)
    const lineages = entry.lanes === undefined ? null : entry.lanes
    const lineage = lineageByLead.get(leadId)
    return {
      leadId,
      label: teamLabel(goal, entry.lead, projections),
      summary: one.summary,
      attention: one.attention,
      roster: merged,
      lanes: entry.lanes === undefined ? null : entry.lanes,
      aliases: aliasesFor(aliasStore(config && config.aliasFile), leadId),
      laneCounts: entry.laneCounts === undefined ? null : entry.laneCounts,
      // What needs a human, before anything that does not.
      waitingOnYou: waitingOnYouOf(merged, lineages),
      // How much session hangs off this coordinator.
      lineage:
        lineage === undefined
          ? { state: 'unavailable', reason: 'the lineage was not read', forks: null, subagents: null, other: null, branches: null, rows: [], truncated: false, rowState: 'unavailable' }
          : lineage,
      goal,
      // A team with no tasks and nobody running is history, not work in flight.
      dormant,
    }
  })
  // Working teams first; dormant ones keep their relative order and are
  // collapsed by the panel rather than deleted from the payload.
  const teams = built0.filter((team) => !team.dormant).concat(built0.filter((team) => team.dormant))

  // The aggregate goal is the union of the per-team reads, so `goals.get` is
  // still called exactly once per lead — a second pass would double the cost of
  // the most expensive read on this endpoint.
  const built = payload(result.summary, result.attention, roster, defects(), mergeGoals(teams.map((team) => team.goal)))
  built.teams = teams
  built.waitingOnYou = mergeWaitingOnYou(teams)
  built.limits = { members: memberLimit }
  return built
}

/** Fold per-team goal views into the one the headline and the glyph use. */
function mergeGoals(views) {
  const goals = []
  let unavailable = 0
  // Keep the first real cause: replacing it with a generic string would hide
  // "the goal service is not registered" behind "could not be read".
  let reason = null
  for (const view of views) {
    if (!view || view.state === 'unavailable') {
      unavailable += 1
      if (reason === null && view && typeof view.reason === 'string') reason = view.reason
      continue
    }
    if (Array.isArray(view.goals)) goals.push(...view.goals)
  }
  if (goals.length > 0) return { state: 'ok', goals }
  if (unavailable > 0) return { state: 'unavailable', reason: reason === null ? 'the goal view could not be read' : reason, goals: [] }
  return { state: 'none', goals: [] }
}

/**
 * A human handle for one Team.
 *
 * The goal objective is the only durable statement of what a team is *for*, so
 * it is the label when it exists; a short session id is the fallback. Never a
 * derived guess from task text.
 */
function teamLabel(goal, lead, projections) {
  // 1. the Session's own title: the handle a human already recognises from the
  //    sidebar. Read defensively — the projection may not be registered.
  if (projections !== undefined) {
    try {
      const value = projections.stateOf(lead.session, 'title')
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch {
      /* fall through to the goal */
    }
  }
  const goals = goal && Array.isArray(goal.goals) ? goal.goals : []
  for (const row of goals) {
    if (row && typeof row.objective === 'string' && row.objective.trim() !== '') {
      const text = row.objective.trim().replace(/\s+/g, ' ')
      return text.length > 96 ? text.slice(0, 95) + '\u2026' : text
    }
  }
  const id = leadIdOf(lead)
  if (id === null) return 'team'
  // Strip the session prefix so the handle is the id's own discriminator, not
  // the tail of the word "session".
  const bare = id.replace(/^session-/, '')
  return 'team ' + (bare.length > 8 ? bare.slice(0, 8) : bare)
}

// ===================== actions =============================================

// ===================== panel aliases ======================================
// Agent Teams stores a member's name immutably: it is the address every
// `send_message` target resolves through, and the roster keeps no rename event.
// So a rename cannot be real, and pretending otherwise would break messaging.
// What the panel CAN own is an annotation: a display alias and a one-line purpose,
// persisted beside the profile, clearly marked everywhere it appears. The Team
// address never changes; the alias never pretends to be it.

const DEFAULT_ALIAS_FILE = path.join(os.homedir(), '.dsh', 'team-progress', 'aliases.json')

function aliasStore(file) {
  const target = typeof file === 'string' && file !== '' ? file : DEFAULT_ALIAS_FILE
  try {
    const raw = fs.readFileSync(target, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeAliasStore(file, store) {
  const target = typeof file === 'string' && file !== '' ? file : DEFAULT_ALIAS_FILE
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(store, null, 2))
}

/** Aliases are keyed `leadId|memberId`, so two teams cannot collide. */
function aliasesFor(store, leadId) {
  const out = {}
  for (const [key, value] of Object.entries(store)) {
    const at = key.indexOf('|')
    if (at === -1 || key.slice(0, at) !== String(leadId)) continue
    out[key.slice(at + 1)] = value
  }
  return out
}

/** One nudge used when the caller does not supply a message. */
const DEFAULT_NUDGE =
  'Status check from the team panel: you hold an in-progress task. Reply with one line of progress, or complete or release the task if it is done.'

/**
 * The caller signal every panel action passes to `sendMessage`.
 *
 * `SendTeamMessageRequest.signal` is REQUIRED, and the domain builds its
 * dispatch signal with `AbortSignal.any([request.signal, lifecycle.signal])`
 * (agent-team/src/mailbox.ts). Passing nothing therefore throws
 * `ERR_INVALID_ARG_TYPE: signals[0] is not of type AbortSignal` before the
 * message is journaled — which is exactly how Wake/Nudge answered HTTP 500
 * while Complete/Reopen/Stop kept working (`UpdateTeamTaskRequest` and
 * `interrupt` take no signal at all). The `send_message` tool passes
 * `exec.signal` for the same field.
 *
 * It never aborts on purpose. An HTTP request that has already answered leaves
 * the host nothing to cancel, and the message is durable in the mailbox before
 * dispatch is attempted: aborting a dispatch would not unsend it, it would only
 * strand a wake as `queued`. The service lifecycle signal remains the one real
 * cancellation, and the domain composes it in regardless.
 */
const PANEL_SIGNAL = new AbortController().signal

/**
 * The delivery observation `sendMessage` returned, or `null` when the domain
 * gave none. `null` is not `accepted`: a panel that cannot read the status must
 * not invent one, so the client words it as a plain receipt.
 */
function deliveryStatusOf(result) {
  if (result === null || typeof result !== 'object') return null
  const status = result.status
  return status === 'accepted' || status === 'queued' ? status : null
}

function invalidArgument(message) {
  const error = new Error(message)
  error.code = 'TEAM_PROGRESS_INVALID_ARGUMENT'
  return error
}

/**
 * Resolve the exact live Lead a request acts as.
 *
 * Every mutation is performed AS the Lead, through the same `ctx.agentTeams`
 * methods the model's own tools call, so the domain keeps its authority checks:
 * this panel adds a control surface, never a weaker path.
 */
function callerFor(ctx, teamSvc, agents, leadId) {
  if (!isName(leadId)) throw invalidArgument('leadId is required')
  const lead = agents.get(leadId)
  if (lead === undefined || lead === null) throw invalidArgument('that lead session is not live')
  let membership
  try {
    membership = teamSvc.tryMembership(lead)
  } catch {
    membership = undefined
  }
  if (membership === undefined || membership === null) throw invalidArgument('that session is not a team lead')
  if (membership.role !== 'lead') throw invalidArgument('that session is not a team lead')
  return membership.root === undefined || membership.root === null ? lead : membership.root
}

async function performAct(ctx, config, args) {
  if (config.allowMutations !== true) {
    const error = new Error('team actions are disabled for this profile (config.allowMutations: true enables them)')
    error.code = 'TEAM_PROGRESS_ACTIONS_DISABLED'
    throw error
  }
  const agents = service(ctx, 'agents')
  const teamSvc = service(ctx, 'agentTeams')
  if (agents === undefined) throw invalidArgument('the agent registry is not available')
  if (teamSvc === undefined) throw invalidArgument('Agent Teams is not available on this profile')

  const input = args === null || typeof args !== 'object' ? {} : args
  const caller = callerFor(ctx, teamSvc, agents, input.leadId)
  const action = String(input.action === undefined ? '' : input.action)

  // A second gate, narrower than `allowMutations`. It is opt-in withholding, never
  // opt-in granting: an unreadable or unknown policy never widens what is reachable,
  // because the permissive value has to be spelled out as `'all'` by the profile.
  if (config.actionPolicy === 'read-write' && DESTRUCTIVE_ACTIONS.has(action)) {
    const error = new Error('`' + action + '` is withheld by this profile (config.actionPolicy: \'read-write\' keeps the board actions and refuses the ones that create an agent or rewrite a config file)')
    error.code = 'TEAM_PROGRESS_ACTION_WITHHELD'
    throw error
  }

  if (action === 'wake') {
    const target = String(input.target === undefined ? '' : input.target)
    if (!isName(target)) throw invalidArgument('target is required')
    const message = isName(input.message) ? input.message : DEFAULT_NUDGE
    // sendMessage resumes an inactive target, which is the point of the button.
    // `signal` is required by the domain: see PANEL_SIGNAL.
    const delivery = await teamSvc.sendMessage(caller, {
      target,
      content: [{ type: 'text', text: message }],
      signal: PANEL_SIGNAL,
    })
    // `accepted` means the target took it now; `queued` means it is durable but
    // was not deliverable this instant. The panel reports the difference rather
    // than claiming a wake the host did not observe delivered.
    return { ok: true, action, target, message, delivery: deliveryStatusOf(delivery) }
  }

  if (action === 'interrupt') {
    const target = String(input.target === undefined ? '' : input.target)
    if (!isName(target)) throw invalidArgument('target is required')
    const started = Date.now()
    const result = teamSvc.interrupt(caller, target)
    return {
      ok: true,
      action,
      target,
      previousStatus: result === null || result === undefined ? null : result.previousStatus,
      tookMs: Date.now() - started,
    }
  }

  if (action === 'task') {
    const taskId = String(input.taskId === undefined ? '' : input.taskId)
    if (!/^task-\d+$/.test(taskId)) throw invalidArgument('taskId must look like task-12')
    const expectedRevision = input.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw invalidArgument('expectedRevision is required: it is the compare-and-set guard')
    }
    const op = String(input.op === undefined ? '' : input.op)
    if (['complete', 'reopen', 'release', 'claim', 'reassign', 'delete', 'set_dependencies'].indexOf(op) === -1) {
      throw invalidArgument('op must be complete, reopen, release, claim, reassign, delete or set_dependencies')
    }
    const request = { taskId, expectedRevision, action: op }
    if (op === 'set_dependencies') {
      // The only way a task can land in the BLOCKED lane: a declared dependency.
      // Prose that says "blocked" is not a dependency, and the board says so.
      const raw = Array.isArray(input.blockedBy) ? input.blockedBy : null
      if (raw === null) throw invalidArgument('blockedBy must be an array of task ids (empty clears it)')
      const blockedBy = raw.map((id) => String(id)).filter((id) => /^task-\d+$/.test(id))
      if (blockedBy.length !== raw.length) throw invalidArgument('blockedBy must contain only task-N ids')
      if (blockedBy.indexOf(taskId) !== -1) throw invalidArgument('a task cannot block itself')
      request.blockedBy = blockedBy
    }
    if (op === 'reassign') {
      // The Lead assigns by name; '' unassigns. The domain refuses a reassign that
      // is not by the Lead, so this op cannot be used to act as someone else.
      const owner = input.owner === undefined ? '' : String(input.owner)
      if (owner !== '' && !isName(owner)) throw invalidArgument('owner must be a member name, or empty to unassign')
      request.owner = owner
    }
    const task = await teamSvc.updateTask(caller, request)
    const receipt = { ok: true, action, taskId, op, task: task === undefined ? null : task, notified: null }

    // `reassign` writes ownerId + in_progress and stops there: it never touches the
    // owner's mailbox, and an inactive teammate only starts on a message. Assigning
    // from the board therefore assigns AND tells the owner, which is the two calls a
    // Lead makes by hand. `notify: false` keeps the bare domain behaviour available.
    if (op === 'reassign' && request.owner !== '' && input.notify !== false) {
      const owner = String(request.owner)
      const subject = task !== null && task !== undefined && isName(task.subject) ? task.subject : taskId
      const text = 'You now own ' + taskId + ': ' + subject
        + '\n\nIt is assigned to you and marked in_progress on the team board.'
        + ' Work it, then mark it completed with team_task_update({ task_id: "' + taskId + '", action: "complete", expected_revision: <current> }).'
      try {
        const delivery = await teamSvc.sendMessage(caller, {
          target: owner,
          content: [{ type: 'text', text }],
          signal: PANEL_SIGNAL,
        })
        receipt.notified = { target: owner, delivery: deliveryStatusOf(delivery) }
      } catch (error) {
        // The assignment stands; the wake did not. Say which half failed.
        receipt.notified = { target: owner, delivery: null, code: codeOf(error) || 'TEAM_NOTIFY_FAILED', error: reasonOf(error) }
      }
    }
    return receipt
  }

  if (action === 'create') {
    const subject = String(input.subject === undefined ? '' : input.subject).trim()
    if (subject === '') throw invalidArgument('subject is required')
    if (subject.length > 200) throw invalidArgument('subject must be 200 characters or fewer')
    // `description` is REQUIRED by the domain (`requiredText` throws on empty), and
    // omitting it crashed inside the service with "undefined.trim" rather than a
    // named refusal. A one-line create therefore copies the subject instead of
    // inventing prose; a caller that has more to say sends `description`.
    const described = input.description === undefined ? '' : String(input.description).trim()
    if (described.length > 16384) throw invalidArgument('description must be 16384 characters or fewer')
    const request = { subject, description: described === '' ? subject : described }
    const task = await teamSvc.createTask(caller, request)
    return { ok: true, action, taskId: task === undefined || task === null ? null : task.id, task: task === undefined ? null : task }
  }

  if (action === 'alias') {
    const memberId = String(input.memberId === undefined ? '' : input.memberId)
    if (memberId === '') throw invalidArgument('memberId is required')
    const alias = input.alias === undefined ? '' : String(input.alias).trim()
    const purpose = input.purpose === undefined ? '' : String(input.purpose).trim()
    if (alias.length > 80) throw invalidArgument('alias must be 80 characters or fewer')
    if (purpose.length > 200) throw invalidArgument('purpose must be 200 characters or fewer')
    // A member of THIS team only: the key is scoped by the lead the action acts as.
    const members = teamSvc.listMembers(caller)
    if (!Array.isArray(members) || !members.some((member) => member && String(member.id) === memberId)) {
      throw invalidArgument('that member is not on this team')
    }
    const hidden = input.hidden === true
    const store = aliasStore(config.aliasFile)
    const key = String(input.leadId) + '|' + memberId
    const previous = store[key] !== null && typeof store[key] === 'object' ? store[key] : {}
    const record = {
      alias: alias === '' && previous.alias !== undefined ? previous.alias : alias,
      purpose: purpose === '' && previous.purpose !== undefined ? previous.purpose : purpose,
      hidden,
    }
    // A record that says nothing at all is deleted, not kept as empty noise.
    if (record.alias === '' && record.purpose === '' && record.hidden !== true) delete store[key]
    else store[key] = record
    writeAliasStore(config.aliasFile, store)
    return { ok: true, action, memberId, alias: record.alias === undefined ? '' : record.alias, purpose: record.purpose === undefined ? '' : record.purpose, hidden: record.hidden === true }
  }

  if (action === 'release') {
    // The strongest teardown the domain actually offers. Not a roster delete —
    // Agent Teams has no remove op — but it stops the member's runtime and archives
    // its session durably, which is what "free the resources" means in practice:
    //   * `stopTeammates` drains the continuable child (its live agent runtime),
    //   * `archiveSession({stopActivity})` cancels turns/jobs/schedules and removes
    //     the session from the app's list.
    // The roster row survives, so the member cap is NOT freed. The receipt says so.
    const memberId = String(input.memberId === undefined ? '' : input.memberId)
    if (memberId === '') throw invalidArgument('memberId is required')
    const members = teamSvc.listMembers(caller)
    const member = Array.isArray(members) ? members.find((row) => row && String(row.id) === memberId) : undefined
    if (member === undefined) throw invalidArgument('that member is not on this team')
    if (member.role === 'lead') throw invalidArgument('the Lead cannot release itself')

    const receipt = { action, memberId, name: member.name, drained: false, archived: false, archivedCode: null, hidden: true }

    const roster = teamSvc.roster
    if (roster !== undefined && typeof roster.stopTeammates === 'function') {
      try {
        await roster.stopTeammates(caller, [memberId])
        receipt.drained = true
      } catch (error) {
        receipt.archivedCode = codeOf(error) || 'TEAM_RELEASE_DRAIN_FAILED'
      }
    }

    const workspace = service(ctx, 'workspaceRegistry')
    if (workspace !== undefined && typeof workspace.archiveSession === 'function') {
      try {
        await workspace.archiveSession(memberId, { stopActivity: true })
        receipt.archived = true
      } catch (error) {
        receipt.archivedCode = codeOf(error) || 'TEAM_RELEASE_ARCHIVE_FAILED'
      }
    }

    // The panel drops the row from the moment the release lands.
    const store = aliasStore(config.aliasFile)
    const key = String(input.leadId) + '|' + memberId
    const previous = store[key] !== null && typeof store[key] === 'object' ? store[key] : {}
    store[key] = { alias: previous.alias || '', purpose: previous.purpose || '', hidden: true }
    writeAliasStore(config.aliasFile, store)

    return {
      ok: true,
      ...receipt,
      // Stated, not implied: the roster entry and its cap slot remain.
      slotFreed: false,
    }
  }

  if (action === 'member-limit') {
    // `maxMembers` is read once, when the Agent Teams service is constructed, so the
    // only honest way to change it from the panel is to write the patch row that the
    // profile watcher re-applies. This edits the home patch layer, keeps a timestamped
    // backup beside it, and says where it wrote — no silent change to a file the owner
    // chose a value in.
    const value = Number(input.value)
    if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
      throw invalidArgument('member limit must be a whole number between 1 and 200')
    }
    const target = typeof config.homePatchFile === 'string' && config.homePatchFile !== ''
      ? config.homePatchFile
      : path.join(os.homedir(), '.dsh', 'cordis.patch.yml')
    let text
    try {
      text = fs.readFileSync(target, 'utf8')
    } catch (error) {
      throw invalidArgument('the patch layer could not be read: ' + reasonOf(error))
    }
    const backup = target + '.bak-team-progress-' + String(Date.now())
    fs.writeFileSync(backup, text)
    const rowPattern = /(- id: agent-team\n(?:.*\n)*?\s+maxMembers: )(\d+)/
    let next
    if (rowPattern.test(text)) {
      next = text.replace(rowPattern, (match, prefix) => prefix + String(value))
    } else {
      const tail = text.endsWith('\n') ? text : text + '\n'
      next = tail
        + '\n# member cap, set from the team board on ' + new Date().toISOString().slice(0, 10) + '\n'
        + '- id: agent-team\n  config:\n    maxMembers: ' + String(value) + '\n'
    }
    fs.writeFileSync(target, next)
    const applied = teamSvc.config !== undefined && Number.isSafeInteger(teamSvc.config.maxMembers)
      ? teamSvc.config.maxMembers
      : null
    return {
      ok: true,
      action,
      value,
      file: target,
      backup,
      // The running service keeps its old cap until the watcher re-applies the row.
      appliedBeforeReload: applied,
      note: 'the profile watcher re-applies the agent-team row within a second',
    }
  }

  if (action === 'spawn') {
    if (typeof teamSvc.spawnTeammate !== 'function') throw invalidArgument('this profile cannot create teammates')
    const name = String(input.name === undefined ? '' : input.name).trim()
    if (name === '') throw invalidArgument('name is required')
    if (name.length > 64) throw invalidArgument('name must be 64 characters or fewer')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw invalidArgument('name must be lower-kebab-case')
    const promptText = String(input.prompt === undefined ? '' : input.prompt).trim()
    if (promptText === '') throw invalidArgument('prompt is required')
    const description = String(input.description === undefined ? 'created from the team board' : input.description).trim()
    const context = input.context === 'fork' ? 'fork' : 'fresh'
    // The provider names mirror the Team tool's own defaults; a profile that routes
    // subagents differently sets `spawnFreshProvider` / `spawnForkProvider` here.
    const provider = context === 'fork' ? config.spawnForkProvider : config.spawnFreshProvider
    const member = await teamSvc.spawnTeammate(caller, {
      name,
      description: description === '' ? 'created from the team board' : description,
      prompt: [
        {
          type: 'text',
          text: '<system-reminder>\nYou are teammate "' + name + '".\nYour Team Lead is named "lead".\n'
            + 'Use list_agents({}) to find your teammates and their names.\n'
            + 'To message your Team Lead, use send_message({ target: "lead", message: "..." }).\n'
            + 'To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n'
            + '</system-reminder>\n',
        },
        { type: 'text', text: promptText },
      ],
      context,
      provider,
      signal: PANEL_SIGNAL,
    })
    return { ok: true, action, name, context, member: member === undefined ? null : member }
  }

  if (action === 'auto-assign') {
    // Give every unowned ready task an owner: an idle teammate first, and — only if
    // the caller asks for it — a new teammate when nobody is free. `dryRun` returns
    // the same plan without touching the board, so the panel can show the numbers
    // before anyone is woken or created.
    const tasks = teamSvc.listTasks(caller)
    const members = teamSvc.listMembers(caller)
    if (!Array.isArray(tasks) || !Array.isArray(members)) throw invalidArgument('the board could not be read')
    const unowned = tasks.filter((task) => task && task.status === 'pending' && task.ready !== false && !isName(task.ownerName))
    const busy = new Set(tasks.filter((task) => task && task.status === 'in_progress' && isName(task.ownerName)).map((task) => String(task.ownerName)))
    const idlePool = members
      .filter((member) => member && member.role !== 'lead' && isName(member.name))
      .filter((member) => !busy.has(String(member.name)) && memberStatus(member) !== 'running')
      .map((member) => String(member.name))
    const allowSpawn = input.spawn === true
    const limit = teamSvc.config !== undefined && Number.isSafeInteger(teamSvc.config.maxMembers) ? teamSvc.config.maxMembers : null
    const rosterRoom = limit === null ? Infinity : Math.max(0, limit - members.length)
    const maxSpawns = Number.isSafeInteger(input.maxSpawns) ? Math.max(0, input.maxSpawns) : rosterRoom

    const plan = []
    const idle = idlePool.slice()
    let spawnsLeft = allowSpawn ? Math.min(rosterRoom, maxSpawns) : 0
    for (const task of unowned) {
      if (idle.length > 0) {
        plan.push({ taskId: String(task.id), subject: labelOf(task), revision: task.revision, owner: idle.shift(), spawn: null })
        continue
      }
      if (spawnsLeft > 0) {
        spawnsLeft -= 1
        plan.push({ taskId: String(task.id), subject: labelOf(task), revision: task.revision, owner: null, spawn: 'auto-' + String(task.id) })
        continue
      }
      plan.push({
        taskId: String(task.id),
        subject: labelOf(task),
        revision: task.revision,
        owner: null,
        spawn: null,
        skip: limit !== null && members.length >= limit ? 'the roster is at its limit (' + String(limit) + ')' : 'no idle teammate',
      })
    }

    if (input.dryRun === true) {
      return { ok: true, action, dryRun: true, ready: unowned.length, idle: idlePool, plan, spawnAllowed: allowSpawn, rosterRoom }
    }

    const assigned = []
    const spawned = []
    const failed = []
    for (const step of plan) {
      if (step.skip !== undefined) continue
      try {
        let owner = step.owner
        if (owner === null && step.spawn !== null) {
          await teamSvc.spawnTeammate(caller, {
            name: step.spawn,
            description: 'auto-created for ' + step.taskId,
            prompt: [{ type: 'text', text: 'You own ' + step.taskId + ': ' + step.subject + '\n\nRead the task with team_task_list, do the work, then complete it with team_task_update.' }],
            context: 'fresh',
            provider: config.spawnFreshProvider,
            signal: PANEL_SIGNAL,
          })
          spawned.push({ name: step.spawn, taskId: step.taskId })
          owner = step.spawn
        }
        const task = await teamSvc.updateTask(caller, {
          taskId: step.taskId,
          expectedRevision: step.revision,
          action: 'reassign',
          owner,
        })
        // Same wake the assign button performs: the domain never messages an owner.
        let notified = null
        try {
          const delivery = await teamSvc.sendMessage(caller, {
            target: owner,
            content: [{ type: 'text', text: 'You now own ' + step.taskId + ': ' + step.subject + '\n\nIt is assigned to you and marked in_progress. Work it, then complete it with team_task_update.' }],
            signal: PANEL_SIGNAL,
          })
          notified = deliveryStatusOf(delivery)
        } catch (error) {
          notified = null
        }
        assigned.push({ taskId: step.taskId, owner, notified, status: task === undefined || task === null ? null : task.status })
      } catch (error) {
        failed.push({ taskId: step.taskId, code: codeOf(error) || 'TEAM_AUTO_ASSIGN_FAILED', error: reasonOf(error) })
      }
    }
    return { ok: true, action, dryRun: false, ready: unowned.length, assigned, spawned, failed, skipped: plan.filter((step) => step.skip !== undefined) }
  }

  if (action === 'wake-owners') {
    // Every in-progress task has an owner who is supposed to be on it. This is the
    // one sweep that is not a broadcast: each owner gets a message naming THEIR task,
    // and a delivery receipt per target.
    // `tryMembership` exists on every build; `membership` throws for non-members.
    const self = typeof teamSvc.tryMembership === 'function' ? teamSvc.tryMembership(caller) : undefined
    const selfName = self !== undefined && self !== null && isName(self.name) ? self.name : 'lead'
    const tasks = teamSvc.listTasks(caller)
    if (!Array.isArray(tasks)) throw invalidArgument('the task board could not be read')
    // A keepalive sweep must not spam owners that are already working: `onlyStalled`
    // narrows it to in-progress tasks whose owner's live status is not running.
    const onlyStalled = input.onlyStalled === true
    let statusByName = new Map()
    if (onlyStalled) {
      const members = teamSvc.listMembers(caller)
      if (Array.isArray(members)) {
        statusByName = new Map(members.filter((row) => row && isName(row.name)).map((row) => [String(row.name), memberStatus(row)]))
      }
    }
    const byOwner = new Map()
    for (const task of tasks) {
      if (task === null || task === undefined) continue
      if (task.status !== 'in_progress' || !isName(task.ownerName)) continue
      if (onlyStalled && statusByName.get(String(task.ownerName)) === 'running') continue
      const owner = String(task.ownerName)
      if (!byOwner.has(owner)) byOwner.set(owner, [])
      byOwner.get(owner).push(task)
    }
    const deliveries = []
    const skipped = []
    for (const [owner, owned] of byOwner) {
      if (owner === selfName) {
        // The Lead owns tasks and cannot message itself; there is nobody to wake.
        skipped.push({ target: owner, tasks: owned.map((task) => task.id), reason: 'the Lead owns this work itself' })
        continue
      }
      const lines = owned.map((task) => task.id + ': ' + labelOf(task)).join('\n- ')
      const text = 'Status check from the team board. You own '
        + (owned.length === 1 ? 'this task' : String(owned.length) + ' in-progress tasks') + ':\n- ' + lines
        + '\n\nWork them now and reply with one line of progress, or mark each completed with team_task_update once it is done.'
      try {
        const delivery = await teamSvc.sendMessage(caller, {
          target: owner,
          content: [{ type: 'text', text }],
          signal: PANEL_SIGNAL,
        })
        deliveries.push({ target: owner, tasks: owned.map((task) => task.id), delivery: deliveryStatusOf(delivery) })
      } catch (error) {
        deliveries.push({ target: owner, tasks: owned.map((task) => task.id), delivery: null, code: codeOf(error) || 'TEAM_WAKE_OWNERS_FAILED', error: reasonOf(error) })
      }
    }
    return {
      ok: true,
      action,
      onlyStalled,
      sent: deliveries.length,
      accepted: deliveries.filter((row) => row.delivery === 'accepted').length,
      queued: deliveries.filter((row) => row.delivery === 'queued').length,
      // The installed build answers sendMessage without a delivery status. That is
      // "dispatched, unconfirmed", never "failed": only an error code is a failure.
      unconfirmed: deliveries.filter((row) => row.delivery === null && row.code === undefined).length,
      failed: deliveries.filter((row) => row.code !== undefined),
      skipped,
      targets: deliveries.map((row) => row.target),
      deliveries,
    }
  }

  if (action === 'broadcast') {
    const message = String(input.message === undefined ? '' : input.message).trim()
    if (message === '') throw invalidArgument('message is required')
    if (message.length > 4000) throw invalidArgument('message must be 4000 characters or fewer')
    // Every teammate the domain knows, lead excluded: this is the one action that
    // multiplies, so it reports each delivery rather than a single ok.
    const members = teamSvc.listMembers(caller)
    if (!Array.isArray(members)) throw invalidArgument('the member list could not be read')
    const targets = members
      .filter((member) => member && member.role !== 'lead' && isName(member.name))
      .map((member) => member.name)
    const deliveries = []
    for (const target of targets) {
      try {
        const result = await teamSvc.sendMessage(caller, {
          target,
          content: [{ type: 'text', text: message }],
          signal: PANEL_SIGNAL,
        })
        deliveries.push({ target, delivery: deliveryStatusOf(result) })
      } catch (error) {
        deliveries.push({ target, delivery: null, code: codeOf(error) || 'TEAM_BROADCAST_FAILED', error: reasonOf(error) })
      }
    }
    const accepted = deliveries.filter((row) => row.delivery === 'accepted').length
    const queued = deliveries.filter((row) => row.delivery === 'queued').length
    return {
      ok: true,
      action,
      sent: deliveries.length,
      accepted,
      queued,
      // Dispatched with no status reported is not a failure; only a code is.
      unconfirmed: deliveries.filter((row) => row.delivery === null && row.code === undefined).length,
      failed: deliveries.filter((row) => row.code !== undefined),
      // A broadcast reaches every teammate or it reports why it did not.
      targets,
    }
  }

  throw invalidArgument('unknown action ' + echo(action))
}

// ===================== transport ===========================================

function send(res, code, obj) {
  const body = JSON.stringify(obj === undefined ? { ok: true } : obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Read the body with a hard cap. A hostile caller cannot make the host buffer an
 * unbounded request, and the cap is checked while streaming rather than after.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('the request body is larger than ' + MAX_BODY_BYTES + ' bytes')
      error.code = 'TEAM_PROGRESS_BODY_TOO_LARGE'
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** HTTP status for a domain failure: a bad request is not a server fault. */
function statusOf(error) {
  const code = codeOf(error)
  if (code === 'TEAM_PROGRESS_ACTIONS_DISABLED') return 403
  if (code === 'TEAM_PROGRESS_ACTION_WITHHELD') return 403
  if (code === 'TEAM_PROGRESS_INVALID_ARGUMENT') return 400
  if (code === 'TEAM_MEMBER_NOT_FOUND') return 404
  // TeamError carries a string code; every one of those is a refused operation.
  if (typeof code === 'string' && code.indexOf('TEAM_') === 0) return 409
  return 500
}

/** The error's own code, or an empty string. */
function codeOf(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
}

function echo(value) {
  const text = String(value)
  return text.length > MAX_METHOD_ECHO ? text.slice(0, MAX_METHOD_ECHO) + '…' : text
}

export function apply(ctx, config) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[team-progress] webServer service unavailable — panel RPC not registered')
    return
  }

  // Defect-log paths come from config ONLY. They are never read from the request
  // body: this endpoint must not become an arbitrary-file reader.
  const configured = config && Array.isArray(config.defectLogs) ? config.defectLogs : DEFAULT_DEFECT_LOGS
  const resolved = {
    defectLogs: configured
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => expandHome(entry.trim())),
    // Mutations are OFF unless the profile opts in. The endpoint is a loopback
    // HTTP surface outside the app's own auth middleware, so a read-only panel
    // is the safe default and acting on the team is an explicit owner choice.
    allowMutations: Boolean(config && config.allowMutations === true),
    // Narrower than `allowMutations` and independent of it: an unknown or missing
    // value resolves to `all`, which is what every pre-existing profile means, and a
    // typo can never silently withhold actions the owner expects. The resolved value
    // is published in the payload's `actions.policy` so the panel can name it.
    actionPolicy: ACTION_POLICIES.has(config && config.actionPolicy) ? config.actionPolicy : 'all',
    // Subagent provider names, matching the Team tool's own defaults. A profile
    // that routes subagents differently overrides these here.
    spawnFreshProvider: config && typeof config.spawnFreshProvider === 'string' ? config.spawnFreshProvider : 'spawn',
    spawnForkProvider: config && typeof config.spawnForkProvider === 'string' ? config.spawnForkProvider : 'fork',
    aliasFile: config && typeof config.aliasFile === 'string' ? config.aliasFile : DEFAULT_ALIAS_FILE,
    homePatchFile: config && typeof config.homePatchFile === 'string' ? config.homePatchFile : path.join(os.homedir(), '.dsh', 'cordis.patch.yml'),
  }

  // Object.create(null) so a method name like "constructor" or "__proto__" has
  // no inherited member to resolve to: an unknown method is always a 404.
  const handlers = Object.create(null)
  handlers.state = (args) => buildState(
    ctx,
    new Date().toISOString(),
    resolved,
    args !== null && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : undefined,
  )
  handlers.act = (args) => performAct(ctx, resolved, args)

  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' })

            let raw
            try {
              raw = await readBody(req)
            } catch (error) {
              if (error && error.code === 'TEAM_PROGRESS_BODY_TOO_LARGE') {
                return send(res, 413, { ok: false, error: reasonOf(error) })
              }
              return send(res, 400, { ok: false, error: 'the request body could not be read: ' + reasonOf(error) })
            }

            let input
            try {
              input = JSON.parse(raw === '' ? '{}' : raw)
            } catch {
              return send(res, 400, { ok: false, error: 'the request body is not valid JSON' })
            }
            if (input === null || typeof input !== 'object' || Array.isArray(input)) {
              return send(res, 400, { ok: false, error: 'the request body must be a JSON object' })
            }
            if (typeof input.method !== 'string' || input.method === '') {
              return send(res, 400, { ok: false, error: 'method must be a non-empty string' })
            }

            const fn = handlers[input.method]
            if (typeof fn !== 'function') {
              return send(res, 404, { ok: false, error: 'unknown method: ' + echo(input.method) })
            }
            // Awaited: `state` is synchronous but `act` returns a promise, and
            // JSON.stringify(promise) would answer with an empty object.
            const result = await fn(input.args === undefined ? null : input.args)
            send(res, 200, result === undefined ? { ok: true } : result)
          } catch (error) {
            send(res, statusOf(error), { ok: false, code: codeOf(error), error: reasonOf(error) })
          }
        },
      }),
    'team-progress-rpc',
  )

  ctx.logger?.info?.('[team-progress] panel RPC ready at ' + ROUTE)
}
