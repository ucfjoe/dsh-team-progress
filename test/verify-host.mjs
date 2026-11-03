// Offline verification harness — host half.
//
// Boots lib/index.js against a fake cordis ctx (webServer + agents + sessionProjections
// + agentTeams + goals), then drives the registered RPC handler over a fake req/res pair.
// No DSH process, no network, no profile files touched.
//
// What this pins, beyond the counts:
//   A. six-task board    — the summary shape, stalled from an in_progress task owned
//                          by an inactive member, attention sorted stalled-first
//   A2. read path        — leads only, never member ids
//   B. two leads         — exactly ONE tryMembership per lead, boards aggregated
//   C. empty board       — a real 0, not a degraded read
//   D. plain chat lead   — skipped silently
//   E. board read throws — total is null, never 0, and the hole is disclosed
//   E2. service fails, durable record readable — counts kept, no false alarm
//   F. projection path   — real counts, stalled null (live status unavailable)
//   G. roster unreadable — counts kept, member half disclosed, stalled null
//   H. no agents service — nothing enumerable => every count null
//   I. transport         — POST only, unknown method, malformed body, no webServer
//   J. no webServer      — logs loudly instead of throwing
//   K. invariants        — disjoint counts, no ETA/percentage/duration field
//   L. lookup keys       — agents.get() is never called; member ids are not keys
//
// 0.2.0 additions:
//   M. roster view       — member → claimed task → task status; STALLED for an
//                          inactive member owning an in_progress task; NOT stalled
//                          for a provisioning member or a running one; a member
//                          that claimed nothing reports taskId null
//   N. defect view       — statuses counted exactly from fixture data; a MISSING
//                          file is `unavailable` with counts null, never 0
//   O. goal view         — armed goal reports objective/roundsStarted/maxGoalRounds/
//                          phase; no armed goal is `none` (renders "no goal");
//                          an absent service and a throwing get() are `unavailable`
//   P. hostile caller    — inherited Object keys are not methods; oversized body
//                          is 413; non-object body and non-string method are 400;
//                          a request cannot redirect the defect-log path
//   Q. no fabricated 0   — every `unavailable` view carries a reason and null counts
//
// Run: node test/verify-host.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
const ok = (label) => console.log('  ok   ' + label)
const bad = (label, detail) => {
  failures += 1
  console.log('  FAIL ' + label + (detail ? '\n         ' + detail : ''))
}
const check = (cond, label, detail) => (cond ? ok(label) : bad(label, detail))

const hostModule = await import(path.join(here, '..', 'lib', 'index.js'))

console.log('host bundle')
check(typeof hostModule.name === 'string', 'exports a plugin name (' + hostModule.name + ')')
check(Array.isArray(hostModule.inject), 'exports inject[] ' + JSON.stringify(hostModule.inject))
check(hostModule.inject.includes('webServer'), 'injects webServer')
check(!hostModule.inject.includes('agentTeams'), 'does not hard-inject agentTeams (a disabled bundle must not break the panel)')
check(!hostModule.inject.includes('goals'), 'does not hard-inject goals (a disabled goal bundle must not break the panel)')
check(typeof hostModule.apply === 'function', 'exports apply()')

// ------------------------------------------------------------- fixtures ------
const session = (id, createdAt) => ({ id, header: { id, createdAt, parentSession: undefined }, seq: 12 })
const lead = (id, status, createdAt) => ({ id, status, options: { model: 'deepseek-chat' }, session: session(id, createdAt) })

const task = (id, status, ownerName, blockedBy, ready) => ({
  id,
  revision: 1,
  subject: 'task ' + id,
  status,
  blockedBy: blockedBy || [],
  ...(ownerName === undefined ? {} : { ownerName }),
  ...(ready === undefined ? {} : { ready }),
})

const LEAD_ROW = { id: 'session-a', name: 'lead', role: 'lead', status: 'running', model: 'deepseek-chat' }
const ALPHA_ROW = { id: 'session-b', name: 'alpha', role: 'teammate', status: 'running', model: 'deepseek-chat' }
const BETA_ROW = { id: 'session-c', name: 'beta', role: 'teammate', status: 'inactive' }
const ROSTER = [LEAD_ROW, ALPHA_ROW, BETA_ROW]

// The 6-task board the summary is documented against:
//   3 completed · 2 in progress (one stalled) · 0 pending-ready · 1 blocked
const SIX_TASKS = [
  task('task-1', 'completed', 'lead'),
  task('task-2', 'completed', 'lead'),
  task('task-3', 'completed', 'alpha'),
  task('task-4', 'in_progress', 'alpha'),
  // In progress, owned by an INACTIVE member: the stalled case.
  task('task-5', 'in_progress', 'beta'),
  // Pending with an unfinished blocker (task-4 is still in progress).
  task('task-6', 'pending', 'lead', ['task-4'], false),
]

const emptyProjection = (id) => ({ id, members: [], tasks: [], delivered: [], nextTaskNumber: 1 })

// ---------------------------------------------------- defect-log fixtures ----
// Same document shape as the real log: several `# | Defect | Evidence | Status`
// tables, a bolded status carrying a trailing PR reference, escaped pipes, and one
// row whose status is outside the documented vocabulary.
const DEFECT_DOC = `# Fixture defects — 2026-10-30

Status: **fixed** (PR merged) · **in flight** (PR open) · **open** (no fix yet).

---

## Blocked the investigation

| # | Defect | Evidence | Status |
|---|---|---|---|
| 1 | **Resolver returned a neighbouring service.** Fuzzy matching accepted any candidate. | \`Resolved: customer-onboarding-service\` | **fixed** #222 — MATCH_EXACT before voting |
| 2 | **Repo→app mapping is dead code.** \`kb_client=None\` at both call sites. | \`investigate.py:319-321\` | **open** |
| 3 | **Honeycomb columns arrived as markdown.** Consumers iterated the dict. | captured payload | **fixed** #226 |

## Wrong output, not yet blocking

| # | Defect | Evidence | Status |
|---|---|---|---|
| 4 | **False CRITICAL.** 17.0x on a \`\\|\` window with no criticals. | Slack card 11:46 | **open** — task-17 |
| 5 | **A run that dies says nothing.** No line distinguishes crashed from working. | log ends mid-phase | **in flight** |
| 6 | **Something with a new status.** Nobody agreed on the word for this. | — | **deferred** |

Trailing prose that is not a table row.
`

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-progress-test-'))
const DEFECT_PATH = path.join(tmpRoot, 'defects.md')
fs.writeFileSync(DEFECT_PATH, DEFECT_DOC, 'utf8')
const MISSING_DEFECT_PATH = path.join(tmpRoot, 'does-not-exist.md')

// Expected counts for DEFECT_DOC, by hand: fixed 1,3 · open 2,4 · in flight 5 ·
// other 6. Six rows, two tables.
const DEFECT_COUNTS = { fixed: 2, inFlight: 1, open: 2, superseded: 0, other: 1, total: 6 }

// The live defect log writes SOME rows of one table separated by BLANK LINES.
// A strict markdown reader ends the table at the first blank line, which silently
// dropped 4 of that document's 32 entries — a count that disagreed with the file.
// This fixture reproduces that shape: one table, four rows, two of them separated
// by a blank line, plus a following table that must still be found separately.
const DEFECT_BLANK_DOC = `# Blank-line separated rows

| # | Defect | Evidence | Status |
|---|---|---|---|
| 1 | **First row.** Adjacent to the header. | \`a.py:1\` | **fixed** |
| 2 | **Second row.** Adjacent to the first. | \`a.py:2\` | **open** |

| 3 | **Third row.** Separated by a BLANK line, still one table. | \`a.py:3\` | **in flight** |

| 4 | **Fourth row.** Also separated, also still one table. | \`a.py:4\` | **open** |

---

## A following table

| # | Defect | Evidence | Status |
|---|---|---|---|
| 5 | **Fifth row.** In its own table after a heading. | \`b.py:5\` | **fixed** |

Trailing prose.
`

// The document owns the vocabulary. These five rows pin the policy: four documented
// states are recognised, and a phrasing outside them (`partly fixed`) is counted as
// `unclassified` rather than squeezed into `fixed` or given a bucket of its own.
const DEFECT_VOCAB_DOC = `# Vocabulary

| # | Defect | Evidence | Status |
|---|---|---|---|
| 1 | A merged fix. | \`a:1\` | **fixed #222** — MATCH_EXACT before voting |
| 2 | An open PR. | \`a:2\` | **in flight** |
| 3 | No fix yet. | \`a:3\` | **open** — task-17 |
| 4 | Real work that will not land as itself. | \`a:4\` | **closed as superseded, not merged** — PR #256 closed after the rebase aborted |
| 5 | A description, not a state. | \`a:5\` | **partly fixed** — \`has_incident()\` still ignores \`mode\` |
`

const DEFECT_VOCAB_PATH = path.join(tmpRoot, 'defects-vocabulary.md')
fs.writeFileSync(DEFECT_VOCAB_PATH, DEFECT_VOCAB_DOC, 'utf8')
// By hand: one of each documented state, and `partly fixed` unclassified.
const DEFECT_VOCAB_COUNTS = { fixed: 1, inFlight: 1, open: 1, superseded: 1, other: 1, total: 5 }

const DEFECT_BLANK_PATH = path.join(tmpRoot, 'defects-blank-lines.md')
fs.writeFileSync(DEFECT_BLANK_PATH, DEFECT_BLANK_DOC, 'utf8')
// By hand: fixed 1,5 · open 2,4 · in flight 3. Five rows, TWO tables.
const DEFECT_BLANK_COUNTS = { fixed: 2, inFlight: 1, open: 2, superseded: 0, other: 0, total: 5 }

function makeWorld(options = {}) {
  const state = { route: null }
  const agents = new Map()
  const calls = { roots: 0, get: [], tryMembership: [], listMembers: [], listTasks: [], goalGet: [], filterSessions: [], mutations: [] }
  const tasksByLead = new Map()
  const rosters = new Map()
  const projections = new Map()
  const goalsByLead = new Map()
  // Children of a lead session, keyed by the lead's session id. The real read is
  // `sessionQuery.filterSessions([{ kind: 'parent', values: [id] }])`, so the fake
  // answers the same filter and nothing else.
  const childrenByLead = new Map()
  // Titles the projection cache serves, keyed by session id. This is the same
  // materialized cell the shipped sidebar lists — NOT the log title fold, which
  // answers "no title" for every session in this profile.
  const titlesBySession = new Map()

  const webServer = {
    register(spec) {
      state.route = spec
      return () => {
        state.route = null
      }
    },
  }

  const addLead = (spec) => {
    const agent = lead(spec.session.id, spec.status || 'running', spec.session.header.createdAt)
    agents.set(agent.id, agent)
    tasksByLead.set(agent.id, spec.tasks || [])
    rosters.set(agent.id, spec.members || [LEAD_ROW])
    projections.set(agent.id, spec.projection || emptyProjection(agent.id))
    if (spec.goal !== undefined) goalsByLead.set(agent.id, spec.goal)
    return agent
  }

  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'agents') {
        if (options.noAgents) return undefined
        return {
          roots: () => {
            calls.roots += 1
            return [...agents.values()]
          },
          get: (id) => {
            calls.get.push(id)
            return agents.get(id)
          },
          list: () => [...agents.values()],
        }
      }
      if (name === 'sessionProjections') {
        if (options.noProjections) return undefined
        return {
          stateOf: (sessionRef, key) => {
            if (key !== 'agentTeam') return undefined
            const found = projections.get(sessionRef && sessionRef.id)
            if (typeof found === 'function') return found()
            return found
          },
        }
      }
      if (name === 'sessionQuery') {
        if (options.noSessionQuery) return undefined
        return {
          filterSessions: (filters) => {
            calls.filterSessions.push(filters)
            if (options.throwLineage) throw new Error('the store exploded')
            const parent = Array.isArray(filters) && filters[0] && Array.isArray(filters[0].values) ? filters[0].values[0] : undefined
            const rows = childrenByLead.get(parent) || []
            return Promise.resolve(rows.map((header) => ({ header, live: false, persisted: true })))
          },
        }
      }
      if (name === 'sessionProjectionCache') {
        if (options.noProjectionCache) return undefined
        return {
          cachedSnapshot: (header, keys) => {
            if (options.throwProjectionCache) throw new Error('the cache exploded')
            const title = titlesBySession.get(header && header.id)
            if (title === undefined) return undefined
            const values = {}
            if (keys === undefined || keys.includes('title')) values.title = title
            return { asOfSeq: 1, values }
          },
        }
      }
      if (name === 'agentTeams') {
        if (options.noTeams) return undefined
        return {
          tryMembership: (agent) => {
            calls.tryMembership.push(agent && agent.id)
            if (options.notALead) return { root: agent, id: agent.id, role: 'teammate', name: 'alpha' }
            if (options.noMembership) return undefined
            return { root: agent, id: agent.id, role: 'lead', name: 'lead' }
          },
          // The three domain mutations the panel is allowed to reach. They are
          // recorded, never performed: this harness must not touch a real team.
          //
          // `AbortSignal.any` is the real domain's own first move
          // (agent-team/src/mailbox.ts: `AbortSignal.any([request.signal,
          // lifecycle.signal])`), so calling it here makes this fake refuse
          // exactly what the real service refuses. v0.4.0 shipped a `sendMessage`
          // request with no `signal`, so every Wake/Nudge answered HTTP 500
          // (`ERR_INVALID_ARG_TYPE: signals[0] is not of type AbortSignal`).
          // A permissive stub is why this suite stayed green.
          sendMessage: (caller, request) => {
            AbortSignal.any([request.signal])
            calls.mutations.push({ op: 'sendMessage', caller: caller && caller.id, request })
            return Promise.resolve({ status: 'accepted' })
          },
          interrupt: (caller, target) => {
            calls.mutations.push({ op: 'interrupt', caller: caller && caller.id, target })
            return { previousStatus: 'running' }
          },
          spawnTeammate: (caller, request) => {
            calls.mutations.push({ op: 'spawnTeammate', caller: caller && caller.id, request })
            return Promise.resolve({ member: { name: request && request.name, role: 'teammate', status: 'provisioning' } })
          },
          createTask: (caller, request) => {
            calls.mutations.push({ op: 'createTask', caller: caller && caller.id, request })
            return Promise.resolve({ id: 'task-90', revision: 1, status: 'pending', subject: request && request.subject })
          },
          updateTask: (caller, request) => {
            calls.mutations.push({ op: 'updateTask', caller: caller && caller.id, request })
            return Promise.resolve({ id: request.taskId, revision: request.expectedRevision + 1, status: 'completed' })
          },
          listMembers: (agent) => {
            calls.listMembers.push(agent && agent.id)
            if (options.throwMembers) throw new Error('members exploded')
            return rosters.get(agent.id) || [LEAD_ROW]
          },
          listTasks: (agent) => {
            calls.listTasks.push(agent && agent.id)
            if (options.throwTasks) throw new Error('tasks exploded')
            return tasksByLead.get(agent.id) || []
          },
        }
      }
      if (name === 'goals') {
        if (options.noGoals) return undefined
        if (options.goalsWithoutGet) return {}
        return {
          get: (agent) => {
            calls.goalGet.push(agent && agent.id)
            if (options.throwGoal) throw new Error('agent is not the registry\'s live instance')
            return goalsByLead.get(agent && agent.id)
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
  }

  const addChild = (leadSessionId, header) => {
    const rows = childrenByLead.get(leadSessionId) || []
    rows.push(header)
    childrenByLead.set(leadSessionId, rows)
  }

  const setTitle = (sessionId, title) => titlesBySession.set(sessionId, title)

  return { ctx, state, calls, addLead, addChild, setTitle, agents, tasksByLead, projections, goalsByLead }
}

// ------------------------------------------------------------ rpc harness ----
function makeRpc(getRoute) {
  return async function rpc(method, bodyText) {
    const route = getRoute()
    const body = bodyText !== undefined ? bodyText : JSON.stringify({ method, args: null })
    let status = 0
    let payload = null
    const req = {
      method: 'POST',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      },
    }
    const res = {
      writeHead(code) {
        status = code
      },
      end(text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = text
        }
      },
    }
    await route.handler(req, res)
    return { status, payload }
  }
}

const TMP_ALIAS = '/tmp/dsh-team-progress-test-aliases.json'
const TMP_PATCH = '/tmp/dsh-team-progress-test-patch.yml'

function boot(world, config) {
  hostModule.apply(world.ctx, { aliasFile: TMP_ALIAS, homePatchFile: TMP_PATCH, ...config })
  const route = world.state.route
  return { route, rpc: route ? makeRpc(() => route) : null }
}

const SHAPE = ['ok', 'generatedAt', 'summary', 'roster', 'defects', 'goal', 'attention', 'actions', 'teams', 'waitingOnYou', 'degraded', 'limits']
const SUMMARY_KEYS = ['total', 'completed', 'inProgress', 'pendingReady', 'blocked', 'stalled', 'members']

/** The Overview question, and the lineage count, are part of the contract now. */
function checkWaitingOnYou(payload, label) {
  const row = payload.waitingOnYou
  check(
    row !== undefined && ['ok', 'partial', 'unavailable'].includes(row.state),
    label + ': waitingOnYou.state is ok/partial/unavailable (got ' + String(row && row.state) + ')',
  )
  const keys = ['total', 'stalled', 'unassigned', 'idle']
  check(
    row !== undefined && keys.every((key) => row[key] === null || Number.isFinite(row[key])),
    label + ': waitingOnYou counters are finite numbers or null, never undefined',
  )
  // The fold must not print a total the parts cannot support.
  if (row && row.total !== null) {
    check(
      row.total === row.stalled + row.unassigned,
      label + ': waitingOnYou.total is stalled + unassigned (got ' + String(row.total) + ')',
    )
  }
}

function checkLineage(team, label) {
  const row = team && team.lineage
  check(
    row !== undefined && ['ok', 'unavailable'].includes(row.state),
    label + ': lineage.state is ok/unavailable (got ' + String(row && row.state) + ')',
  )
  if (row && row.state === 'ok') {
    check(
      row.branches === row.forks + row.subagents + row.other,
      label + ': lineage.branches is forks + subagents + other (got ' + String(row.branches) + ')',
    )
  }
}

function checkShape(payload, label) {
  check(
    JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(SHAPE.slice().sort()),
    label + ': payload has exactly ' + SHAPE.join('/') + ' (got ' + Object.keys(payload).join('/') + ')',
  )
  check(
    payload.summary && JSON.stringify(Object.keys(payload.summary).sort()) === JSON.stringify(SUMMARY_KEYS.slice().sort()),
    label + ': summary has exactly ' + SUMMARY_KEYS.join('/'),
  )
  check(
    payload.degraded && typeof payload.degraded.any === 'boolean' && Array.isArray(payload.degraded.reasons),
    label + ': degraded is { any:boolean, reasons:[] }',
  )
  check(
    typeof payload.generatedAt === 'string' && new Date(payload.generatedAt).toISOString() === payload.generatedAt,
    label + ': generatedAt is an ISO timestamp (' + payload.generatedAt + ')',
  )
}

// ============================================================== A. six tasks ==
console.log('\nA. six-task board — one lead, one stalled task, one blocked task')
const A = makeWorld()
A.addLead({ session: session('session-a', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
// Two delegated children and one forked child: the three kinds lineage counts
// apart, because "branched" and "delegated" are different answers.
A.addChild('session-a', { version: 4, id: 'child-1', createdAt: 1761000001000, isSeeded: false, origin: 'subagent', delegationDepth: 1 })
A.addChild('session-a', { version: 4, id: 'child-2', createdAt: 1761000002000, isSeeded: false, origin: 'subagent', delegationDepth: 1 })
A.addChild('session-a', { version: 4, id: 'child-3', createdAt: 1761000003000, parentSession: 'session-a', isSeeded: true })
const a = boot(A)
check(a.route !== null, 'apply() registers the RPC route')
check(a.route && a.route.path === '/api/team-progress/rpc', 'route path is /api/team-progress/rpc')
check(a.route && a.route.kind === 'exact', 'route is an exact match')

const aState = await a.rpc('state')
check(aState.status === 200 && aState.payload.ok === true, 'state responds 200 + ok:true')
checkShape(aState.payload, 'A')
checkWaitingOnYou(aState.payload, 'A')
checkLineage(aState.payload.teams[0], 'A')
check(
  aState.payload.waitingOnYou.stalled === 1,
  'A: the stalled teammate is counted as waiting on a human (got ' + String(aState.payload.waitingOnYou.stalled) + ')',
)
check(
  aState.payload.waitingOnYou.total === aState.payload.waitingOnYou.stalled + aState.payload.waitingOnYou.unassigned,
  'A: the headline total adds stalled and unassigned only',
)
const aLineage = aState.payload.teams[0].lineage
check(aLineage.forks === 1, 'A: one forked child is a fork (got ' + aLineage.forks + ')')
check(aLineage.subagents === 2, 'A: two delegated children are subagents (got ' + aLineage.subagents + ')')
check(aLineage.branches === 3, 'A: branches is the sum of the three kinds (got ' + aLineage.branches + ')')
check(
  A.calls.filterSessions.length === 1,
  'A: lineage costs exactly one store read per lead (got ' + A.calls.filterSessions.length + ')',
)
check(
  A.calls.filterSessions[0] && A.calls.filterSessions[0][0].kind === 'parent' && A.calls.filterSessions[0][0].values[0] === 'session-a',
  'A: the lineage read is the parent filter for that lead',
)

const aSummary = aState.payload.summary
check(aSummary.total === 6, 'total is 6 (got ' + aSummary.total + ')')
check(aSummary.completed === 3, 'completed is 3 (got ' + aSummary.completed + ')')
check(aSummary.inProgress === 2, 'inProgress is 2 (got ' + aSummary.inProgress + ')')
check(aSummary.pendingReady === 0, 'pendingReady is 0 (got ' + aSummary.pendingReady + ')')
check(aSummary.blocked === 1, 'blocked is 1 (got ' + aSummary.blocked + ')')
check(aSummary.stalled === 1, 'stalled is 1 — in progress, owner inactive (got ' + aSummary.stalled + ')')
check(
  aSummary.completed + aSummary.inProgress + aSummary.pendingReady + aSummary.blocked === aSummary.total,
  'counts are disjoint and sum to the total',
)
check(aSummary.members.total === 3, 'members.total is 3 (got ' + aSummary.members.total + ')')
check(aSummary.members.live === 2, 'members.live is 2 — one roster row is inactive (got ' + aSummary.members.live + ')')
check(aState.payload.degraded.any === false, 'a fully readable board is not degraded')
check(aState.payload.degraded.reasons.length === 0, 'no degraded reasons on a clean read')

const aAttention = aState.payload.attention
check(Array.isArray(aAttention) && aAttention.length === 2, 'two attention items (got ' + (aAttention && aAttention.length) + ')')
check(aAttention[0] && aAttention[0].kind === 'stalled', 'stalled is sorted FIRST in attention (got ' + (aAttention[0] && aAttention[0].kind) + ')')
check(aAttention[0] && aAttention[0].label === 'task task-5', 'the stalled item names its task (' + (aAttention[0] && aAttention[0].label) + ')')
check(
  aAttention[0] && /beta/.test(aAttention[0].detail) && /inactive/.test(aAttention[0].detail),
  'the stalled detail names the owner and its status (' + (aAttention[0] && aAttention[0].detail) + ')',
)
check(aAttention[1] && aAttention[1].kind === 'blocked', 'the blocked item follows (got ' + (aAttention[1] && aAttention[1].kind) + ')')
check(
  aAttention.every((item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(['detail', 'kind', 'label'])),
  'every attention item is exactly { kind, label, detail }',
)

// ---- the read path: leads only, never member ids ----------------------------
console.log('\nA2. read path — one membership call per lead')
check(A.calls.roots === 1, 'agents.roots() is called once (got ' + A.calls.roots + ')')
check(A.calls.tryMembership.length === 1, 'tryMembership is called once for the one lead (got ' + A.calls.tryMembership.length + ')')
check(
  A.calls.tryMembership[0] === 'session-a',
  'tryMembership was passed the LEAD id (got ' + A.calls.tryMembership[0] + ')',
)
const memberIds = ['session-b', 'session-c']
check(
  A.calls.tryMembership.every((id) => !memberIds.includes(id)),
  'tryMembership is never called with a member id',
)
check(
  A.calls.get.length === 0,
  'agents.get() is never called — member ids are not lookup keys (got ' + A.calls.get.length + ' lookups: ' + A.calls.get.join(',') + ')',
)
check(
  A.calls.listTasks.length === 1 && A.calls.listTasks[0] === 'session-a',
  'listTasks is called once, with the lead only',
)
check(
  A.calls.listMembers.length === 1 && A.calls.listMembers[0] === 'session-a',
  'listMembers is called once, with the lead only',
)
check(
  A.calls.goalGet.length === 1 && A.calls.goalGet[0] === 'session-a',
  'goals.get() is called once, with the lead only (got ' + A.calls.goalGet.join(',') + ')',
)

// ============================================================== B. two leads ==
console.log('\nB. two leads — one membership call each, boards aggregated')
const B = makeWorld()
B.addLead({ session: session('session-old', 1761000000000), tasks: [task('task-1', 'completed', 'lead')], members: [LEAD_ROW] })
B.addLead({
  session: session('session-new', 1761000500000),
  tasks: [task('task-1', 'in_progress', 'alpha'), task('task-2', 'completed', 'lead')],
  members: [LEAD_ROW, ALPHA_ROW],
})
const b = boot(B)
const bState = await b.rpc('state')
checkShape(bState.payload, 'B')
check(B.calls.tryMembership.length === 2, 'tryMembership is called once per lead, twice total (got ' + B.calls.tryMembership.length + ')')
check(
  B.calls.tryMembership[0] !== B.calls.tryMembership[1],
  'the two calls used two distinct leads (' + B.calls.tryMembership.join(', ') + ')',
)
check(B.calls.get.length === 0, 'no agent lookups across two teams either')
const bSummary = bState.payload.summary
check(bSummary.total === 3, 'totals are summed across leads (got ' + bSummary.total + ')')
check(bSummary.completed === 2, 'completed is summed across leads (got ' + bSummary.completed + ')')
check(bSummary.stalled === 0, 'the in-progress task is owned by a running member, so nothing is stalled (got ' + bSummary.stalled + ')')
check(bSummary.members.total === 3, 'member counts are summed across leads (got ' + bSummary.members.total + ')')

// ============================================================ C. empty board ==
console.log('\nC. empty board — a real zero, not a degraded read')
const C = makeWorld()
C.addLead({ session: session('session-c', 1761000000000), tasks: [], members: [LEAD_ROW, ALPHA_ROW] })
const c = boot(C)
const cState = await c.rpc('state')
checkShape(cState.payload, 'C')
check(cState.payload.degraded.any === false, 'an empty board is not degraded')
check(cState.payload.summary.total === 0, 'total is a real 0 (got ' + cState.payload.summary.total + ')')
check(
  cState.payload.summary.completed === 0 && cState.payload.summary.stalled === 0,
  'counts are 0 rather than null on a readable empty board',
)
check(cState.payload.attention.length === 0, 'an empty board has no attention items')
check(cState.payload.summary.members.total === 2, 'the roster is still counted (got ' + cState.payload.summary.members.total + ')')

// ========================================================= D. plain chat lead ==
console.log('\nD. plain chat lead with a failing board read — skipped silently')
const D = makeWorld({ throwTasks: true })
D.addLead({ session: session('session-d', 1761000000000), tasks: [], members: [LEAD_ROW] })
const d = boot(D)
const dState = await d.rpc('state')
checkShape(dState.payload, 'D')
check(dState.payload.degraded.any === false, 'an ordinary conversation is NOT reported as degraded')
check(dState.payload.degraded.reasons.length === 0, 'no reason is emitted for a lead with no team')
check(dState.payload.summary.total === 0, 'nothing is counted (got ' + dState.payload.summary.total + ')')
check(dState.payload.summary.stalled === 0, 'no stall is invented')

// ========================================================= E. board unreadable =
console.log('\nE. board read throws — total null, hole disclosed')
// Both read paths must fail for the board to be genuinely unreadable: the
// service throws AND the durable projection registry is unavailable.
const E = makeWorld({ throwTasks: true, noProjections: true })
E.addLead({ session: session('session-e', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const e = boot(E)
const eState = await e.rpc('state')
checkShape(eState.payload, 'E')
check(eState.payload.degraded.any === true, 'degraded.any is true')
check(eState.payload.summary.total === null, 'total is null, NOT 0 (got ' + eState.payload.summary.total + ')')
check(
  eState.payload.summary.completed === null && eState.payload.summary.blocked === null && eState.payload.summary.stalled === null,
  'every task count is null rather than a fabricated number',
)
check(
  eState.payload.degraded.reasons.some((reason) => /task board could not be read/.test(reason)),
  'a short reason names the unreadable board (' + eState.payload.degraded.reasons.join(' | ') + ')',
)
check(eState.payload.summary.members.total === 3, 'the roster is still reported when only the board failed (got ' + eState.payload.summary.members.total + ')')
check(eState.payload.summary.members.live === 2, 'live member count survives a failed board read')
check(eState.payload.attention.length === 0, 'no attention items are invented for an unreadable board')
check(eState.payload.roster.state === 'unavailable', 'the roster view is unavailable when the board could not be read (got ' + eState.payload.roster.state + ')')
check(eState.payload.roster.members.length === 0, 'an unavailable roster invents no member rows')

// ========================================== E2. service read, durable board ===
console.log('\nE2. service board read fails but the durable record is readable — no contradiction')
const E2 = makeWorld({ throwTasks: true })
E2.addLead({
  session: session('session-e2', 1761000000000),
  members: ROSTER,
  projection: {
    id: 'session-e2',
    members: [
      { id: 'session-b', name: 'alpha', description: '', provider: 'spawn', context: 'fresh', phase: 'active' },
      { id: 'session-c', name: 'beta', description: '', provider: 'spawn', context: 'fresh', phase: 'active' },
    ],
    tasks: [
      { id: 'task-1', revision: 1, subject: 'task task-1', description: '', status: 'completed', blockedBy: [], writeScopes: [] },
      { id: 'task-2', revision: 1, subject: 'task task-2', description: '', status: 'completed', blockedBy: [], writeScopes: [] },
      { id: 'task-3', revision: 1, subject: 'task task-3', description: '', status: 'completed', blockedBy: [], writeScopes: [] },
      { id: 'task-4', revision: 1, subject: 'task task-4', description: '', status: 'in_progress', ownerId: 'session-b', blockedBy: [], writeScopes: [] },
      { id: 'task-5', revision: 1, subject: 'task task-5', description: '', status: 'in_progress', ownerId: 'session-c', blockedBy: [], writeScopes: [] },
      { id: 'task-6', revision: 1, subject: 'task task-6', description: '', status: 'pending', blockedBy: ['task-4'], writeScopes: [] },
    ],
    delivered: [],
    nextTaskNumber: 7,
  },
})
const e2 = boot(E2)
const e2State = await e2.rpc('state')
checkShape(e2State.payload, 'E2')
check(e2State.payload.summary.total === 6, 'the board is counted from the durable record (got ' + e2State.payload.summary.total + ')')
check(
  !e2State.payload.degraded.reasons.some((reason) => /could not be read/.test(reason)),
  'no "could not be read" reason contradicts the counts it did read',
)
check(e2State.payload.summary.stalled === 1, 'stalls come from the LIVE roster against durable tasks (got ' + e2State.payload.summary.stalled + ')')
check(e2State.payload.attention[0].kind === 'stalled', 'the stalled item still sorts first')
check(
  e2State.payload.attention[0].detail === 'owner beta is inactive',
  'the detail names the inactive owner (' + e2State.payload.attention[0].detail + ')',
)
check(e2State.payload.roster.state === 'ok', 'a live roster against a durable board is a fully readable roster view')
check(
  e2State.payload.roster.members.find((row) => row.name === 'beta').stalled === true,
  'the durable-path roster still marks the stalled member',
)

// ========================================================= F. projection path =
console.log('\nF. projection fallback — real counts, stalled is null')
const F = makeWorld({ noTeams: true })
F.addLead({
  session: session('session-f', 1761000000000),
  members: [LEAD_ROW, { ...ALPHA_ROW, name: 'gamma', id: 'session-g' }],
  projection: {
    id: 'session-f',
    members: [{ id: 'session-x', name: 'gamma', description: 'worker', provider: 'spawn', context: 'fresh', phase: 'active' }],
    tasks: [
      { id: 'task-1', revision: 1, subject: 'a', description: 'a', status: 'completed', blockedBy: [], writeScopes: [] },
      { id: 'task-2', revision: 1, subject: 'b', description: 'b', status: 'in_progress', ownerId: 'session-x', blockedBy: [], writeScopes: [] },
      { id: 'task-3', revision: 1, subject: 'c', description: 'c', status: 'pending', blockedBy: ['task-2'], writeScopes: [] },
      { id: 'task-4', revision: 1, subject: 'd', description: 'd', status: 'deleted', blockedBy: [], writeScopes: [] },
    ],
    delivered: [],
    nextTaskNumber: 5,
  },
})
const f = boot(F)
const fState = await f.rpc('state')
checkShape(fState.payload, 'F')
check(fState.payload.summary.total === 3, 'deleted tasks are excluded from the total (got ' + fState.payload.summary.total + ')')
check(fState.payload.summary.completed === 1 && fState.payload.summary.inProgress === 1, 'counts come from the durable record')
check(fState.payload.summary.blocked === 1, 'the pending task with an unfinished blocker is blocked')
check(fState.payload.summary.stalled === null, 'stalled is null, not 0: live status is unavailable on this path')
check(fState.payload.degraded.any === true, 'degraded.any is true because live status is missing')
check(
  fState.payload.degraded.reasons.some((reason) => /live member status unavailable/.test(reason)),
  'a short reason names the missing live status',
)
check(F.calls.get.length === 0, 'the fallback also does no agent lookups')
check(fState.payload.roster.state === 'partial', 'the roster view is partial, not ok, without live status (got ' + fState.payload.roster.state + ')')
check(fState.payload.roster.stalled === null, 'the roster stall count is null, not 0, without live status')
check(
  fState.payload.roster.members.every((row) => row.stalled === null),
  'every roster row reports stall as null, never false, without live status',
)
check(
  fState.payload.roster.members.find((row) => row.name === 'gamma').taskId === 'task-2',
  'the roster still names the claimed task from the durable record',
)

// =================================================== G. roster unreadable ====
console.log('\nG. roster unreadable — counts kept, member half disclosed')
const GR = makeWorld({ throwMembers: true })
GR.addLead({ session: session('session-gr', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const gr = boot(GR)
const grState = await gr.rpc('state')
checkShape(grState.payload, 'G-roster')
check(grState.payload.summary.total === 6, 'the board is still counted (got ' + grState.payload.summary.total + ')')
check(GR.calls.get.length === 0, 'a missing roster still triggers no agent lookups')
check(grState.payload.summary.stalled === null, 'stalled is null, not 0: no roster to match owners against (got ' + grState.payload.summary.stalled + ')')
check(grState.payload.summary.members.total === null, 'members.total is null rather than 0 (got ' + grState.payload.summary.members.total + ')')
check(grState.payload.degraded.any === true, 'a missing roster is disclosed')
check(
  grState.payload.degraded.reasons.some((reason) => /live member status unavailable/.test(reason)),
  'a short reason names the missing roster',
)
check(grState.payload.roster.state === 'unavailable', 'the roster view says unavailable (got ' + grState.payload.roster.state + ')')

// ========================================================== H. no agents svc ==
console.log('\nH. no agents service — nothing enumerable')
const G = makeWorld({ noAgents: true })
G.addLead({ session: session('session-g', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const g = boot(G)
const gState = await g.rpc('state')
checkShape(gState.payload, 'H')
check(gState.payload.degraded.any === true, 'degraded.any is true')
check(gState.payload.summary.total === null, 'total is null, not 0 (got ' + gState.payload.summary.total + ')')
check(gState.payload.summary.members.total === null, 'members.total is null too')
check(
  gState.payload.degraded.reasons.some((reason) => /agent registry/.test(reason)),
  'a short reason names the missing registry',
)

// ============================================================ M. roster view ==
console.log('\nM. roster view — member → claimed task → task status')
const M = makeWorld()
M.addLead({
  session: session('session-m', 1761000000000),
  // delta is PROVISIONING and owns an in-progress task: a normal startup state,
  // which must NOT be reported as a stall. epsilon owns two tasks.
  members: [
    LEAD_ROW,
    ALPHA_ROW,
    BETA_ROW,
    { id: 'session-d', name: 'delta', role: 'teammate', status: 'provisioning' },
    { id: 'session-e', name: 'epsilon', role: 'teammate', status: 'inactive' },
    { id: 'session-f', name: 'zeta', role: 'teammate', status: 'running' },
  ],
  tasks: [
    task('task-1', 'in_progress', 'alpha'),
    task('task-2', 'in_progress', 'beta'),
    task('task-3', 'in_progress', 'delta'),
    task('task-4', 'completed', 'epsilon'),
    task('task-5', 'in_progress', 'epsilon'),
    task('task-6', 'pending', 'lead', ['task-1'], false),
  ],
})
const m = boot(M)
const mState = await m.rpc('state')
const mRoster = mState.payload.roster

check(mRoster.state === 'ok', 'the roster view is ok (got ' + mRoster.state + ')')
check(Array.isArray(mRoster.members) && mRoster.members.length === 6, 'one row per roster member (got ' + mRoster.members.length + ')')
const rowOf = (name) => mRoster.members.find((row) => row.name === name)

const betaRow = rowOf('beta')
check(betaRow !== undefined, 'beta has a roster row')
check(betaRow && betaRow.status === 'inactive', 'the row carries the live status (got ' + (betaRow && betaRow.status) + ')')
check(betaRow && betaRow.taskId === 'task-2', 'the row names the CLAIMED task (got ' + (betaRow && betaRow.taskId) + ')')
check(betaRow && betaRow.taskStatus === 'in_progress', 'the row carries the claimed task status (got ' + (betaRow && betaRow.taskStatus) + ')')
check(
  betaRow && betaRow.stalled === true,
  'STALLED: inactive while owning an in-progress task (got ' + (betaRow && betaRow.stalled) + ')',
)
// beta (task-2) and epsilon (task-5) are both inactive over an in-progress task.
check(mRoster.stalled === 2, 'exactly two members are stalled (got ' + mRoster.stalled + ')')

check(rowOf('alpha') && rowOf('alpha').stalled === false, 'a RUNNING owner of an in-progress task is not stalled')
check(rowOf('delta') && rowOf('delta').status === 'provisioning', 'delta is provisioning')
check(
  rowOf('delta') && rowOf('delta').stalled === false,
  'PROVISIONING is not a stall — a starting member is not a stuck one (got ' + (rowOf('delta') && rowOf('delta').stalled) + ')',
)
check(rowOf('epsilon') && rowOf('epsilon').stalled === true, 'an inactive owner of an in-progress task IS stalled')
check(rowOf('epsilon') && rowOf('epsilon').claimed === 2, 'the row reports how many tasks it claims (got ' + (rowOf('epsilon') && rowOf('epsilon').claimed) + ')')
check(
  rowOf('epsilon') && rowOf('epsilon').taskId === 'task-5',
  'the reported claim is the in-progress one, not the completed one (got ' + (rowOf('epsilon') && rowOf('epsilon').taskId) + ')',
)
check(rowOf('zeta') && rowOf('zeta').taskId === null, 'a member that claimed nothing reports a null task, not a zero')
check(rowOf('zeta') && rowOf('zeta').claimed === 0, 'a member that claimed nothing reports claimed: 0')
check(rowOf('zeta') && rowOf('zeta').stalled === false, 'a member with no claim is not stalled')
check(rowOf('lead') && rowOf('lead').role === 'lead', 'the lead appears as a member with role lead')
check(rowOf('lead') && rowOf('lead').taskStatus === 'pending', "the lead's claimed task is reported")
check(rowOf('alpha') && rowOf('alpha').role === 'teammate', 'a teammate carries role teammate')
check(mState.payload.summary.stalled === 2, 'the summary stall count agrees with the roster rows (got ' + mState.payload.summary.stalled + ')')
check(
  mRoster.members.every((row) => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(
    ['claimed', 'id', 'leadId', 'name', 'role', 'stalled', 'status', 'taskId', 'taskRevision', 'taskStatus', 'taskSubject'].slice().sort(),
  )),
  'every roster row has exactly the documented keys',
)

// ============================================================ N. defect view ==
console.log('\nN. defect view — statuses counted exactly, missing file is unavailable')
const N = makeWorld()
N.addLead({ session: session('session-n', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const n = boot(N, { defectLogs: [DEFECT_PATH] })
const nState = await n.rpc('state')
const nDefects = nState.payload.defects

check(nDefects.state === 'ok', 'a readable defect log is ok (got ' + nDefects.state + ')')
check(JSON.stringify(nDefects.counts) === JSON.stringify(DEFECT_COUNTS), 'counts match the fixture exactly (got ' + JSON.stringify(nDefects.counts) + ')')
check(nDefects.counts.total === 6, 'the total is the row count (got ' + nDefects.counts.total + ')')
check(
  nDefects.counts.fixed + nDefects.counts.inFlight + nDefects.counts.open + nDefects.counts.superseded + nDefects.counts.other === nDefects.counts.total,
  'the status buckets are disjoint and sum to the total',
)
check(nDefects.open.length === 2, 'the open rows are listed (got ' + nDefects.open.length + ')')
check(nDefects.open.every((row) => row.status === 'open'), 'every listed row is open')
check(nDefects.open[0] && nDefects.open[0].ref === '2', 'the open row keeps its number (' + (nDefects.open[0] && nDefects.open[0].ref) + ')')
check(
  nDefects.open[0] && !/\*\*/.test(nDefects.open[0].defect),
  'the defect text is plain — markdown emphasis is stripped',
)
check(
  nDefects.open[1] && nDefects.open[1].ref === '4' && nDefects.open[1].section === 'Wrong output, not yet blocking',
  'the row carries its section heading (' + (nDefects.open[1] && nDefects.open[1].section) + ')',
)
check(
  nDefects.open[1] && /task-17/.test(nDefects.open[1].status) === false && nDefects.open[1].status === 'open',
  'a trailing PR/task reference does not change the status',
)
check(
  nDefects.open[1] && /no criticals/.test(nDefects.open[1].defect),
  'an escaped pipe inside a cell does not split the row (' + (nDefects.open[1] && nDefects.open[1].defect) + ')',
)
check(
  nDefects.files[0] && nDefects.files[0].rows === 6,
  'the file record reports its own row count (got ' + (nDefects.files[0] && nDefects.files[0].rows) + ')',
)

// ---- the missing file: unavailable, never 0 --------------------------------
console.log('\nN2. defect view — a missing file is unavailable, never 0')
const N2 = makeWorld()
N2.addLead({ session: session('session-n2', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const n2 = boot(N2, { defectLogs: [MISSING_DEFECT_PATH] })
const n2State = await n2.rpc('state')
const n2Defects = n2State.payload.defects
check(n2Defects.state === 'unavailable', 'a missing defect log is unavailable (got ' + n2Defects.state + ')')
check(n2Defects.counts === null, 'counts are null, NOT 0 (got ' + JSON.stringify(n2Defects.counts) + ')')
check(typeof n2Defects.reason === 'string' && n2Defects.reason !== '', 'the view carries a reason (' + n2Defects.reason + ')')
check(/ENOENT|no such file/.test(n2Defects.reason), 'the reason names the real cause (' + n2Defects.reason + ')')
check(n2Defects.open.length === 0, 'no open rows are invented')
check(
  n2State.payload.degraded.any === false,
  'a missing defect file does NOT make the task board degraded — the view says so itself',
)

// ---- one of two readable: partial, with real counts -----------------------
console.log('\nN3. defect view — one log readable, one missing => partial')
const N3 = makeWorld()
N3.addLead({ session: session('session-n3', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const n3 = boot(N3, { defectLogs: [DEFECT_PATH, MISSING_DEFECT_PATH] })
const n3Defects = (await n3.rpc('state')).payload.defects
check(n3Defects.state === 'partial', 'a partly readable log set is partial (got ' + n3Defects.state + ')')
check(
  JSON.stringify(n3Defects.counts) === JSON.stringify(DEFECT_COUNTS),
  'the readable file still contributes its exact counts (got ' + JSON.stringify(n3Defects.counts) + ')',
)
check(n3Defects.files.length === 2, 'both configured files are reported')
check(
  n3Defects.files.filter((file) => file.state === 'unavailable').length === 1,
  'the unreadable file is named rather than dropped',
)

// ---- no configured paths ---------------------------------------------------
console.log('\nN4. defect view — no configured paths')
const N4 = makeWorld()
N4.addLead({ session: session('session-n4', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const n4Defects = (await boot(N4, { defectLogs: [] }).rpc('state')).payload.defects
check(n4Defects.state === 'unavailable', 'an empty path list is unavailable (got ' + n4Defects.state + ')')
check(n4Defects.counts === null, 'counts are null, not 0')
check(/no defect-log paths/.test(n4Defects.reason), 'the reason says no paths are configured (' + n4Defects.reason + ')')

// ---- the shipped default ---------------------------------------------------
console.log('\nN5. defect view — the shipped default is empty, and says so')
const N5 = makeWorld()
N5.addLead({ session: session('session-n5', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const n5Defects = (await boot(N5).rpc('state')).payload.defects
check(n5Defects.state === 'unavailable', 'with no config the defects view is unavailable (got ' + n5Defects.state + ')')
check(n5Defects.counts === null, 'and its counts are null, not 0')
check(/no defect-log paths/.test(n5Defects.reason), 'and the reason names the missing config (' + n5Defects.reason + ')')

// ---- rows separated by BLANK lines (the live log's real shape) ------------
console.log('\nN6. defect view — blank lines between rows do not drop entries')
const N6 = makeWorld()
N6.addLead({ session: session('session-n6', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const n6Defects = (await boot(N6, { defectLogs: [DEFECT_BLANK_PATH] }).rpc('state')).payload.defects
check(
  JSON.stringify(n6Defects.counts) === JSON.stringify(DEFECT_BLANK_COUNTS),
  'every row is counted across a blank-line split, matching the hand count (got ' + JSON.stringify(n6Defects.counts) + ')',
)
check(n6Defects.counts.total === 5, 'all five rows are counted, none silently dropped (got ' + n6Defects.counts.total + ')')
check(
  n6Defects.open.length === 2 && n6Defects.open.some((row) => row.ref === '3') === false,
  'the rows after a blank line are real rows, and the in-flight one is not open (' + n6Defects.open.map((r) => r.ref).join(',') + ')',
)
check(
  n6Defects.open.some((row) => row.ref === '4'),
  'the row separated by TWO blank lines is still counted (' + n6Defects.open.map((r) => r.ref).join(',') + ')',
)
check(
  n6Defects.files[0].rows === 5,
  'the file record counts five rows (got ' + n6Defects.files[0].rows + ')',
)

// ---- the four documented states, and nothing invented ---------------------
console.log('\nN7. defect view — four documented states, an unknown phrasing stays unclassified')
const N7 = makeWorld()
N7.addLead({ session: session('session-n7', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const n7Defects = (await boot(N7, { defectLogs: [DEFECT_VOCAB_PATH] }).rpc('state')).payload.defects
check(
  JSON.stringify(n7Defects.counts) === JSON.stringify(DEFECT_VOCAB_COUNTS),
  'each documented state is counted in its own bucket (got ' + JSON.stringify(n7Defects.counts) + ')',
)
check(n7Defects.counts.superseded === 1, '\'closed as superseded, not merged\' resolves to the superseded bucket, not other (got ' + n7Defects.counts.superseded + ')')
check(
  n7Defects.counts.other === 1,
  '`partly fixed` stays UNCLASSIFIED: the document gets the vocabulary, the panel does not grow a bucket (got ' + n7Defects.counts.other + ')',
)
check(
  n7Defects.counts.fixed === 1 && n7Defects.counts.inFlight === 1,
  'a trailing PR reference does not move a row between buckets',
)
check(n7Defects.open.length === 1 && n7Defects.open[0].ref === '3', 'only the `open` row is listed as open')

// ============================================================== O. goal view ==
console.log('\nO. goal view — rounds counted, phases named')
const O = makeWorld()
O.addLead({
  session: session('session-o', 1761000000000),
  tasks: SIX_TASKS,
  members: ROSTER,
  goal: {
    id: 'goal-1',
    revision: 3,
    objective: 'Extend dsh-team-progress with the four views',
    phase: 'active',
    maxGoalRounds: 256,
    roundsStarted: 7,
    createdAt: 1761000000000,
    updatedAt: 1761000900000,
    activation: 'armed',
  },
})
const oState = await boot(O).rpc('state')
const oGoal = oState.payload.goal
check(oGoal.state === 'ok', 'an armed goal is ok (got ' + oGoal.state + ')')
check(oGoal.goals.length === 1, 'one goal is reported')
check(
  oGoal.goals[0].objective === 'Extend dsh-team-progress with the four views',
  'the objective is passed through verbatim',
)
check(oGoal.goals[0].roundsStarted === 7, 'roundsStarted is a COUNT of rounds begun (got ' + oGoal.goals[0].roundsStarted + ')')
check(oGoal.goals[0].maxGoalRounds === 256, 'maxGoalRounds is the documented cap (got ' + oGoal.goals[0].maxGoalRounds + ')')
check(oGoal.goals[0].phase === 'active', 'the phase is named (got ' + oGoal.goals[0].phase + ')')
check(oGoal.goals[0].activation === 'armed', 'activation distinguishes armed from disarmed')
check(oGoal.goals[0].leadId === 'session-o', 'the goal names its lead')

// ---- no goal armed: "no goal", not zeros ----------------------------------
console.log('\nO2. goal view — no armed goal is `none`, which renders "no goal"')
const O2 = makeWorld()
O2.addLead({ session: session('session-o2', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const o2State = await boot(O2).rpc('state')
check(o2State.payload.goal.state === 'none', 'an unarmed goal is none (got ' + o2State.payload.goal.state + ')')
check(o2State.payload.goal.goals.length === 0, 'no goals are listed')
check(o2State.payload.goal.roundsStarted === undefined, 'no zero round count is fabricated')
check(
  !JSON.stringify(o2State.payload.goal).includes('"roundsStarted":0'),
  'nothing reports "0 rounds" for a session that has no goal',
)

// ---- absent service: unavailable, reason named ----------------------------
console.log('\nO3. goal view — an absent goal service is unavailable, not "no goal"')
const O3 = makeWorld({ noGoals: true })
O3.addLead({ session: session('session-o3', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const o3State = await boot(O3).rpc('state')
check(o3State.payload.goal.state === 'unavailable', 'an absent goal service is unavailable (got ' + o3State.payload.goal.state + ')')
check(/not registered/.test(o3State.payload.goal.reason), 'the reason names the missing service (' + o3State.payload.goal.reason + ')')
check(o3State.payload.goal.goals.length === 0, 'no goals are invented')

// ---- get() throws: unavailable, never "no goal" ---------------------------
console.log('\nO4. goal view — get() throwing is unavailable, NOT "no goal"')
const O4 = makeWorld({ throwGoal: true })
O4.addLead({ session: session('session-o4', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const o4State = await boot(O4).rpc('state')
check(
  o4State.payload.goal.state === 'unavailable',
  'a goal read that throws is unavailable, not a confident "no goal" (got ' + o4State.payload.goal.state + ')',
)
check(/live instance/.test(o4State.payload.goal.reason), 'the real cause is surfaced (' + o4State.payload.goal.reason + ')')

// ---- a service without get() ----------------------------------------------
console.log('\nO5. goal view — a service with no get() reader')
const O5 = makeWorld({ goalsWithoutGet: true })
O5.addLead({ session: session('session-o5', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const o5State = await boot(O5).rpc('state')
check(o5State.payload.goal.state === 'unavailable', 'a service without get() is unavailable (got ' + o5State.payload.goal.state + ')')

// ============================================================ I. transport ===
console.log('\nI. transport')
const notPost = { method: 'GET', async *[Symbol.asyncIterator]() {} }
let getCode = 0
await a.route.handler(notPost, {
  writeHead: (code) => {
    getCode = code
  },
  end: () => {},
})
check(getCode === 405, 'GET is rejected with 405')

const unknownMethod = await a.rpc('nope')
check(unknownMethod.status === 404, 'unknown method is 404')
check(/unknown method/.test(unknownMethod.payload.error), 'the 404 names the method')

const broken = await a.rpc('state', '{not json')
check(broken.status === 400, 'malformed JSON is a 400 (a client error, not a server fault)')
check(typeof broken.payload.error === 'string' && broken.payload.error.length > 0, 'the 400 carries an error string')

console.log('\nJ. no webServer — logs instead of throwing')
const errors = []
const realError = console.error
console.error = (message) => errors.push(String(message))
try {
  hostModule.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    logger: { info() {}, warn() {}, error() {} },
  })
} catch (error) {
  bad('apply() must not throw without webServer', String(error))
}
console.error = realError
check(errors.some((line) => /webServer service unavailable/.test(line)), 'reports the missing webServer loudly')

// ========================================================= P. hostile caller ==
console.log('\nP. hostile caller — the HTTP surface validates its input')
// Inherited Object keys must not resolve as methods.
for (const inherited of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
  const probe = await a.rpc(inherited)
  check(probe.status === 404, 'method "' + inherited + '" is 404, not an inherited prototype member (got ' + probe.status + ')')
}
const protoProbe = await a.rpc('state', JSON.stringify({ method: 'state', __proto__: { polluted: true } }))
check(protoProbe.status === 200, 'a __proto__ key in the body does not break a valid call')
check({}.polluted === undefined, 'the body cannot pollute Object.prototype')

const notObject = await a.rpc('state', '[]')
check(notObject.status === 400, 'a JSON array body is 400 (got ' + notObject.status + ')')
const nullBody = await a.rpc('state', 'null')
check(nullBody.status === 400, 'a JSON null body is 400 (got ' + nullBody.status + ')')
const noMethod = await a.rpc('state', JSON.stringify({ args: null }))
check(noMethod.status === 400, 'a body with no method is 400 (got ' + noMethod.status + ')')
const numericMethod = await a.rpc('state', JSON.stringify({ method: 7 }))
check(numericMethod.status === 400, 'a non-string method is 400 (got ' + numericMethod.status + ')')
const emptyMethod = await a.rpc('state', JSON.stringify({ method: '' }))
check(emptyMethod.status === 400, 'an empty method is 400 (got ' + emptyMethod.status + ')')

const hugeBody = JSON.stringify({ method: 'state', args: 'x'.repeat(200 * 1024) })
const huge = await a.rpc('state', hugeBody)
check(huge.status === 413, 'an oversized body is 413 (got ' + huge.status + ')')
check(/larger than/.test(huge.payload.error), 'the 413 explains the cap (' + huge.payload.error + ')')

// The defect-log path must come from config only: a request cannot redirect it.
const P = makeWorld()
P.addLead({ session: session('session-p', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
const p = boot(P, { defectLogs: [DEFECT_PATH] })
const plain = await p.rpc('state')
const redirected = await p.rpc('state', JSON.stringify({ method: 'state', args: { defectLogs: ['/etc/passwd'], path: '/etc/passwd' } }))
check(JSON.stringify(redirected.payload.defects) === JSON.stringify(plain.payload.defects), 'request args cannot redirect the defect-log path')
check(
  redirected.payload.defects.files.every((file) => file.path !== '/etc/passwd'),
  'no request-supplied path is ever read',
)

// ============================================================ invariants =====
console.log('\ninvariants')
let invariantChecked = 0
const payloads = [aState.payload, bState.payload, cState.payload, dState.payload, eState.payload, fState.payload, gState.payload, mState.payload]
for (const payload of payloads) {
  const summary = payload.summary
  if (summary.total === null) continue
  invariantChecked += 1
  const sum = summary.completed + summary.inProgress + summary.pendingReady + summary.blocked
  if (sum !== summary.total) bad('disjoint counts', sum + ' !== ' + summary.total)
  // blocked is a SUBSET of pending and is never also counted as in progress
  if (summary.blocked > summary.total) bad('blocked exceeds total', summary.blocked + ' > ' + summary.total)
}
check(invariantChecked > 0, 'disjoint counts hold across ' + invariantChecked + ' readable snapshot(s)')

check(!payloads.some((payload) => payload.unknown !== undefined), 'no legacy `unknown` block is produced')
check(
  !JSON.stringify(payloads).includes('"available"'),
  'no legacy per-team tasks.available block is produced',
)

// Q. no fabricated zeros: every unavailable view carries a reason and no counts.
const qPayloads = [n2State.payload, o3State.payload, o4State.payload, o5State.payload, eState.payload, gState.payload]
for (const payload of qPayloads) {
  const views = [payload.roster, payload.defects, payload.goal]
  for (const view of views) {
    if (view.state === 'unavailable') {
      if (typeof view.reason !== 'string' || view.reason === '') bad('unavailable without a reason', JSON.stringify(view).slice(0, 120))
    }
    if (view.counts === 0) bad('a view reports a bare 0 count', JSON.stringify(view).slice(0, 120))
  }
}
check(true, 'every unavailable view carries a reason and never a bare 0')

const serialized = JSON.stringify(payloads)
check(!/"eta"/i.test(serialized), 'no ETA field is produced')
check(!/"(?:percent|percentage|pct)"/i.test(serialized), 'no percentage field is produced')
check(!/elapsed|durationMs|estimatedRemaining|remainingMs/i.test(serialized), 'no duration or remaining-time field is produced')

// ==================================================== S. one card per team ==
console.log('\nS. teams — unrelated teams never share a card')
{
  // Two leads, two topics: the panel must not fold them into one table.
  const world = makeWorld()
  world.addLead({
    session: session('session-aa11', 1761000000000),
    tasks: [task('task-1', 'in_progress', 'alpha'), task('task-2', 'completed', 'alpha')],
    members: [LEAD_ROW, ALPHA_ROW],
    goal: { id: 'goal-1', objective: 'Investigate the payment retry storm', phase: 'active', roundsStarted: 3, maxGoalRounds: 60, activation: 'armed' },
  })
  world.addLead({
    session: session('session-bb22', 1761000001000),
    tasks: [task('task-1', 'pending', 'beta')],
    members: [LEAD_ROW, BETA_ROW],
  })
  const rpc = boot(world, { defectLogs: [] }).rpc
  const state = await rpc('state')
  const teams = state.payload.teams

  check(Array.isArray(teams) && teams.length === 2, 'two leads produce two teams (' + (teams && teams.length) + ')')
  check(
    teams[0].leadId !== teams[1].leadId,
    'each team carries its own lead id (' + teams.map((t) => t.leadId).join(', ') + ')',
  )
  check(
    teams[0].roster.members.every((row) => row.name !== 'beta'),
    'a team card never lists another team\'s members',
  )
  check(
    teams[0].summary.total === 2 && teams[1].summary.total === 1,
    'per-team counts are that team\'s own (' + teams.map((t) => t.summary.total).join(' / ') + ')',
  )
  check(
    state.payload.summary.total === 3,
    'the headline still counts every team (' + state.payload.summary.total + ')',
  )
  check(
    teams[0].label === 'Investigate the payment retry storm',
    'a team with a goal is labelled by its objective (' + teams[0].label + ')',
  )
  check(
    /^team [a-z0-9]+$/.test(teams[1].label),
    'a team without a goal falls back to a short session id, never a guessed topic (' + teams[1].label + ')',
  )
  check(
    teams.every((team) => team.actions === undefined || typeof team.actions === 'boolean'),
    'the per-team view does not fork the action flag',
  )

  // The goal is read once per lead, and the aggregate is the union.
  check(world.calls.goalGet.length === 2, 'goals.get is still called once per lead (' + world.calls.goalGet.length + ')')
  check(
    Array.isArray(state.payload.goal.goals) && state.payload.goal.goals.length === 1,
    'the aggregate goal carries the union of the teams\' goals (' + (state.payload.goal.goals || []).length + ')',
  )

  // No team at all: an empty list, not a fabricated one.
  const plain = makeWorld()
  plain.addLead({ session: session('session-cc33', 1761000000000), tasks: [], members: [LEAD_ROW] })
  const plainState = await boot(plain, { defectLogs: [] }).rpc('state')
  check(Array.isArray(plainState.payload.teams) && plainState.payload.teams.length === 0, 'an ordinary session reports zero teams, not one empty team')

  // ...but a session that ASKS for its own team gets one, even when empty: the
  // per-session tab has to be able to show a Lead before it has any work.
  const focused = await boot(plain, { defectLogs: [] }).rpc('state', JSON.stringify({ method: 'state', args: { sessionId: 'session-cc33' } }))
  check(
    Array.isArray(focused.payload.teams) && focused.payload.teams.length === 1,
    'a session asking for its own team gets it (' + (focused.payload.teams || []).length + ')',
  )
  check(
    focused.payload.teams && focused.payload.teams[0] && focused.payload.teams[0].leadId === 'session-cc33',
    'and it is that session\'s team',
  )

}

// ================================================== R. the action surface ==
console.log('\nR. action surface — off by default, authority and CAS preserved')
{
  // Off by default: a read-only endpoint cannot mutate a team because a caller
  // guessed the method name.
  const off = makeWorld()
  off.addLead({ session: session('session-a', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
  const offBoot = boot(off, { defectLogs: [] })
  const offRpc = offBoot.rpc
  const offAct = (payload) => offRpc('act', JSON.stringify({ method: 'act', args: payload }))
  const offState = await offRpc('state')
  check(offState.payload.actions && offState.payload.actions.enabled === false, 'actions.enabled is false unless the profile opts in')
  const refused = await offAct({ action: 'wake', leadId: 'session-a', target: 'beta' })
  check(refused.status === 403, 'act is 403 while the profile has not opted in (got ' + refused.status + ')')
  check(refused.payload && refused.payload.code === 'TEAM_PROGRESS_ACTIONS_DISABLED', 'the refusal names the switch')
  check(off.calls.mutations.length === 0, 'a disabled action reaches no domain method')

  // A narrower, independent gate. `actionPolicy: 'read-write'` keeps the board
  // actions and refuses the two that outlive the click. It withholds only when the
  // profile spells it out, so a profile written before the key existed is unchanged.
  const pw = makeWorld()
  pw.addLead({ session: session('session-pw', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
  const pwRpc = boot(pw, { defectLogs: [], allowMutations: true, actionPolicy: 'read-write' }).rpc
  const pwAct = (payload) => pwRpc('act', JSON.stringify({ method: 'act', args: payload }))
  const pwState = await pwRpc('state')
  check(
    pwState.payload.actions && pwState.payload.actions.policy === 'read-write',
    'the payload names the policy in force (' + (pwState.payload.actions && pwState.payload.actions.policy) + ')',
  )
  const withheldSpawn = await pwAct({ action: 'spawn', leadId: 'session-pw', name: 'release-auditor', prompt: 'audit the notes' })
  check(withheldSpawn.status === 403, 'spawn is 403 under read-write (got ' + withheldSpawn.status + ')')
  check(
    withheldSpawn.payload && withheldSpawn.payload.code === 'TEAM_PROGRESS_ACTION_WITHHELD',
    'the refusal names the policy, not the on/off switch (' + (withheldSpawn.payload && withheldSpawn.payload.code) + ')',
  )
  const withheldCap = await pwAct({ action: 'member-limit', leadId: 'session-pw', value: 12 })
  check(withheldCap.status === 403, 'member-limit is 403 under read-write (got ' + withheldCap.status + ')')
  check(pw.calls.mutations.length === 0, 'a withheld action reaches no domain method')
  const allowedTask = await pwAct({ action: 'task', op: 'reassign', leadId: 'session-pw', taskId: 'task-5', expectedRevision: 1, owner: 'alpha', notify: false })
  check(allowedTask.status === 200, 'a board action still runs under read-write (got ' + allowedTask.status + ')')

  const dp = makeWorld()
  dp.addLead({ session: session('session-dp', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
  const dpState = await boot(dp, { defectLogs: [], allowMutations: true }).rpc('state')
  check(
    dpState.payload.actions && dpState.payload.actions.policy === 'all',
    'an absent policy resolves to all, so an existing profile is unchanged (' + (dpState.payload.actions && dpState.payload.actions.policy) + ')',
  )

  // On when configured — and still only through ctx.agentTeams, as the Lead.
  const on = makeWorld()
  on.addLead({ session: session('session-a', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
  const onBoot = boot(on, { defectLogs: [], allowMutations: true })
  const onRpc = onBoot.rpc
  const onAct = (payload) => onRpc('act', JSON.stringify({ method: 'act', args: payload }))
  const onState = await onRpc('state')
  check(onState.payload.actions.enabled === true, 'actions.enabled is true when config.allowMutations is true')

  const wake = await onAct({ action: 'wake', leadId: 'session-a', target: 'beta' })
  check(wake.status === 200 && wake.payload.ok === true, 'wake succeeds (got ' + wake.status + ')')
  const wakeCall = on.calls.mutations.find((call) => call.op === 'sendMessage')
  check(wakeCall !== undefined, 'wake calls agentTeams.sendMessage')
  check(wakeCall && wakeCall.caller === 'session-a', 'wake acts AS the lead, not as the caller-supplied string (got ' + (wakeCall && wakeCall.caller) + ')')
  check(wakeCall && wakeCall.request.target === 'beta', 'wake targets the named member')
  check(
    wakeCall && Array.isArray(wakeCall.request.content) && wakeCall.request.content[0] && wakeCall.request.content[0].type === 'text',
    'wake sends one text content block, the shape the domain accepts',
  )
  check(
    wakeCall && /in-progress task/.test(wakeCall.request.content[0].text),
    'wake carries an actionable default message',
  )
  check(
    wakeCall && wakeCall.request.signal instanceof AbortSignal,
    'wake passes an AbortSignal: the domain requires one and throws without it',
  )
  check(
    wake.payload.delivery === 'accepted',
    'wake reports the delivery the domain returned (got ' + JSON.stringify(wake.payload.delivery) + ')',
  )

  const custom = await onAct({ action: 'wake', leadId: 'session-a', target: 'beta', message: 'ping' })
  check(custom.status === 200, 'wake accepts a caller-supplied message (got ' + custom.status + ')')
  const last = on.calls.mutations.filter((call) => call.op === 'sendMessage').pop()
  check(last && last.request.content[0].text === 'ping', 'the supplied message is used verbatim')

  // The chalkboard reads one projection of the same read: lanes of cards beside
  // the counts, never a second read of the board.
  const boardState = await onRpc('state')
  const teamRow = boardState.payload.teams && boardState.payload.teams[0]
  check(teamRow !== undefined && teamRow.lanes !== null && teamRow.lanes !== undefined, 'a team payload carries lanes for the board')
  check(
    teamRow !== undefined && ['ready', 'inProgress', 'done', 'blocked'].every((key) => Array.isArray(teamRow.lanes[key])),
    'every lane exists, empty or not',
  )
  check(
    teamRow !== undefined && teamRow.laneCounts && teamRow.laneCounts.done === teamRow.summary.completed,
    'the done lane count equals the completed count it is drawn beside (' + JSON.stringify(teamRow && teamRow.laneCounts) + ')',
  )
  check(
    teamRow !== undefined && teamRow.laneCounts.ready === teamRow.summary.pendingReady,
    'the ready lane count equals the pending-ready count',
  )
  check(
    teamRow !== undefined && Object.keys(teamRow.lanes).every((key) => teamRow.lanes[key].length <= 12),
    'a lane is capped, so the payload never becomes a dump',
  )
  const card = teamRow === undefined ? undefined : (teamRow.lanes.ready[0] || teamRow.lanes.inProgress[0] || teamRow.lanes.done[0])
  check(
    card !== undefined && typeof card.subject === 'string' && Object.prototype.hasOwnProperty.call(card, 'owner'),
    'a card carries the subject it is drawn with and an owner slot, assigned or not',
  )

  // The board is the working surface: create, assign, and one broadcast that
  // reports every delivery instead of a single ok.
  const created = await onAct({ action: 'create', leadId: 'session-a', subject: 'Wire the retry budget' })
  check(created.status === 200 && created.payload.taskId === 'task-90', 'create returns the task it made (' + created.status + ')')
  const createCall = on.calls.mutations.filter((call) => call.op === 'createTask').pop()
  check(createCall && createCall.request.subject === 'Wire the retry budget', 'create sends the subject the reader typed')
  const createEmpty = await onAct({ action: 'create', leadId: 'session-a', subject: '   ' })
  check(createEmpty.status === 400, 'create refuses an empty subject (' + createEmpty.status + ')')

  // The domain requires a non-empty description; a one-line create copies the
  // subject instead of crashing inside the service on `undefined.trim`.
  const described = on.calls.mutations.filter((call) => call.op === 'createTask').pop()
  check(
    described && described.request.description === 'Wire the retry budget',
    'create always sends a non-empty description (' + JSON.stringify(described && described.request.description) + ')',
  )
  const spelling = await onAct({ action: 'create', leadId: 'session-a', subject: 'Ship it', description: 'the long version' })
  const spelled = on.calls.mutations.filter((call) => call.op === 'createTask').pop()
  check(spelling.status === 200 && spelled.request.description === 'the long version', 'an explicit description wins over the copy')

  // A hide is persisted beside the profile, so it survives a reload while the
  // team roster keeps the member — hiding is a panel fact, not a roster one.
  const hidden = await onAct({ action: 'alias', leadId: 'session-a', memberId: 'session-b', hidden: true })
  check(hidden.status === 200 && hidden.payload.hidden === true, 'hide writes a persisted record (' + hidden.status + ')')
  const renamed = await onAct({ action: 'alias', leadId: 'session-a', memberId: 'session-b', alias: 'alpha-2', purpose: 'owns the retry budget' })
  check(renamed.status === 200 && renamed.payload.alias === 'alpha-2', 'an alias is stored beside the hide without clearing it')
  const shown = await onAct({ action: 'alias', leadId: 'session-a', memberId: 'session-b', alias: 'alpha-2', purpose: 'owns the retry budget', hidden: false })
  check(shown.payload.hidden === false, 'un-hiding clears the flag')
  const backState = await onRpc('state')
  const backTeam = backState.payload.teams && backState.payload.teams[0]
  check(
    backTeam && backTeam.aliases && ['alpha-2', 'owns the retry budget'].includes(backTeam.aliases['session-b'].alias),
    'the alias rides the payload so a reload keeps it (' + JSON.stringify(backTeam && backTeam.aliases) + ')',
  )

  const spawned = await onAct({ action: 'spawn', leadId: 'session-a', name: 'release-auditor', prompt: 'audit the notes' })
  check(spawned.status === 200, 'spawn succeeds (' + spawned.status + ')')
  const spawnCall = on.calls.mutations.filter((call) => call.op === 'spawnTeammate').pop()
  check(spawnCall && spawnCall.request.provider === 'spawn', 'spawn defaults to the fresh provider the Team tool uses')
  check(spawnCall && spawnCall.request.context === 'fresh', 'spawn defaults to a fresh context')
  check(
    spawnCall && Array.isArray(spawnCall.request.prompt) && spawnCall.request.prompt.length === 2,
    'spawn sends the naming reminder plus the brief',
  )
  const badName = await onAct({ action: 'spawn', leadId: 'session-a', name: 'Not A Name', prompt: 'x' })
  check(badName.status === 400, 'spawn refuses a name the domain would reject (' + badName.status + ')')
  const noPrompt = await onAct({ action: 'spawn', leadId: 'session-a', name: 'ok-name', prompt: '  ' })
  check(noPrompt.status === 400, 'spawn refuses an empty brief (' + noPrompt.status + ')')

  const assigned = await onAct({ action: 'task', op: 'reassign', leadId: 'session-a', taskId: 'task-5', expectedRevision: 1, owner: 'alpha' })
  check(assigned.status === 200, 'reassign is an allowed task op (' + assigned.status + ')')
  const assignCall = on.calls.mutations.filter((call) => call.op === 'updateTask').pop()
  check(assignCall && assignCall.request.action === 'reassign' && assignCall.request.owner === 'alpha', 'reassign names the owner it is assigning')
  on.calls.mutations.length = 0
  const waking = await onAct({ action: 'task', op: 'reassign', leadId: 'session-a', taskId: 'task-5', expectedRevision: 1, owner: 'alpha' })
  const wakeCalls = on.calls.mutations.filter((call) => call.op === 'sendMessage')
  check(wakeCalls.length === 1, 'assigning also messages the owner (' + wakeCalls.length + ')')
  check(
    wakeCalls[0] && wakeCalls[0].request.target === 'alpha' && /task-5/.test(wakeCalls[0].request.content[0].text),
    'the message names the task it assigned',
  )
  check(
    wakeCalls[0] && wakeCalls[0].request.signal instanceof AbortSignal,
    'the wake carries the caller signal the domain requires',
  )
  check(
    waking.payload.notified && waking.payload.notified.delivery === 'accepted',
    'the receipt reports the wake (' + JSON.stringify(waking.payload.notified) + ')',
  )
  on.calls.mutations.length = 0
  await onAct({ action: 'task', op: 'reassign', leadId: 'session-a', taskId: 'task-5', expectedRevision: 1, owner: 'alpha', notify: false })
  check(
    on.calls.mutations.filter((call) => call.op === 'sendMessage').length === 0,
    'notify:false keeps the bare domain behaviour for a caller that does not want a wake',
  )

  const unassigned = await onAct({ action: 'task', op: 'reassign', leadId: 'session-a', taskId: 'task-5', expectedRevision: 1 })
  const unassignCall = on.calls.mutations.filter((call) => call.op === 'updateTask').pop()
  check(unassigned.status === 200 && unassignCall.request.owner === '', 'an absent owner unassigns rather than failing')

  // The member cap: written into the patch layer the profile watcher re-applies,
  // with a backup beside it, and refused outside a sane range.
  fs.writeFileSync(TMP_PATCH, '- id: agent-team\n  config:\n    maxMembers: 8\n')
  const raised = await onAct({ action: 'member-limit', leadId: 'session-a', value: 12 })
  check(raised.status === 200 && raised.payload.value === 12, 'the cap can be set from the panel (' + raised.status + ')')
  const patched = fs.readFileSync(TMP_PATCH, 'utf8')
  check(/maxMembers: 12/.test(patched), 'the row it wrote carries the new value (' + patched.replace(/\n/g, ' ') + ')')
  check(
    fs.readdirSync('/tmp').some((name) => name.startsWith('dsh-team-progress-test-patch.yml.bak-team-progress-')),
    'the previous patch layer is backed up before the write',
  )
  const badCap = await onAct({ action: 'member-limit', leadId: 'session-a', value: 0 })
  check(badCap.status === 400, 'a nonsense cap is refused before any file is written (' + badCap.status + ')')

  // Auto-assign: idle teammates first, a new teammate only when asked, and a
  // dry run that answers with the same plan it would execute.
  // A board with unowned ready work: two chores for the idle beta, plus one more
  // than there are idle teammates so the "no idle" branch is exercised too.
  const autoWorld = makeWorld()
  autoWorld.addLead({
    session: session('session-auto', 1761000000000),
    tasks: [
      task('task-1', 'pending', undefined, [], true),
      task('task-2', 'pending', undefined, [], true),
    ],
    members: [LEAD_ROW, ALPHA_ROW, BETA_ROW],
  })
  const autoBoot = boot(autoWorld, { defectLogs: [], allowMutations: true })
  const autoAct = (payload) => autoBoot.rpc('act', JSON.stringify({ method: 'act', args: payload }))
  on.calls.mutations.length = 0
  const preview = await autoAct({ action: 'auto-assign', leadId: 'session-auto', dryRun: true })
  check(preview.status === 200 && preview.payload.dryRun === true, 'auto-assign previews before it acts (' + preview.status + ')')
  check(
    preview.payload.plan && preview.payload.plan.every((step) => typeof step.taskId === 'string' && typeof step.revision === 'number'),
    'the plan carries each task and the revision it will compare-and-set',
  )
  check(autoWorld.calls.mutations.length === 0, 'a preview mutates nothing')

  autoWorld.calls.mutations.length = 0
  const auto = await autoAct({ action: 'auto-assign', leadId: 'session-auto' })
  check(auto.status === 200, 'auto-assign runs (' + auto.status + ')')
  const autoSpawns = autoWorld.calls.mutations.filter((call) => call.op === 'spawnTeammate')
  check(autoSpawns.length === 0, 'without spawn it creates nobody (' + autoSpawns.length + ')')

  const autoAssigns = autoWorld.calls.mutations.filter((call) => call.op === 'updateTask' && call.request.action === 'reassign')
  check(autoAssigns.length >= 1, 'it reassigns at least one ready task (' + autoAssigns.length + ')')
  check(
    autoAssigns.every((call) => typeof call.request.owner === 'string' && call.request.owner !== ''),
    'every assignment names an owner',
  )
  check(
    auto.payload.assigned.length >= 1 && auto.payload.assigned.every((row) => typeof row.owner === 'string'),
    'the receipt names who got what (' + JSON.stringify(auto.payload.assigned) + ')',
  )
  // With only one idle teammate and two ready tasks, the second is reported as
  // unplaced rather than silently dropped — and spawning is opt-in.
  check(
    auto.payload.skipped.length >= 1 && /no idle teammate/.test(JSON.stringify(auto.payload.skipped)),
    'work with nobody to take it is reported, not dropped (' + JSON.stringify(auto.payload.skipped) + ')',
  )
  autoWorld.calls.mutations.length = 0
  const withSpawn = await autoAct({ action: 'auto-assign', leadId: 'session-auto', spawn: true, maxSpawns: 2 })
  check(
    autoWorld.calls.mutations.filter((call) => call.op === 'spawnTeammate').length === 1,
    'spawn:true creates a teammate only for the work nobody idle could take',
  )
  check(
    withSpawn.payload.spawned.length === 1 && /^auto-task-/.test(withSpawn.payload.spawned[0].name),
    'the created teammate is named after the task it was made for (' + JSON.stringify(withSpawn.payload.spawned) + ')',
  )

  check(
    auto.payload.failed.length === 0 && auto.payload.skipped.length >= 0,
    'and it reports what it could not place',
  )

  // One sweep, one message per owner, each naming that owner's own tasks.
  on.calls.mutations.length = 0
  const sweep = await onAct({ action: 'wake-owners', leadId: 'session-a' })
  check(sweep.status === 200, 'the owner sweep succeeds (' + sweep.status + ')')
  const sweepSends = on.calls.mutations.filter((call) => call.op === 'sendMessage')
  check(sweepSends.length >= 1, 'it messages the owners of in-progress tasks (' + sweepSends.length + ')')
  check(
    sweepSends.every((call) => /team_task_update|in-progress tasks|this task/.test(call.request.content[0].text)),
    'each message says what to do, not just "status?"',
  )
  check(
    sweep.payload.sent === sweepSends.length && Array.isArray(sweep.payload.deliveries),
    'the sweep reports one receipt per owner',
  )
  check(
    sweep.payload.failed.length === 0,
    'a dispatch with no reported status is not counted as a failure (' + JSON.stringify(sweep.payload.failed) + ')',
  )

  on.calls.mutations.length = 0
  const broadcast = await onAct({ action: 'broadcast', leadId: 'session-a', message: 'stand-up in five' })
  check(broadcast.status === 200, 'broadcast succeeds (' + broadcast.status + ')')
  const sent = on.calls.mutations.filter((call) => call.op === 'sendMessage')
  check(sent.length === 2, 'broadcast reaches every teammate, never the lead (' + sent.length + ')')
  check(
    sent.every((call) => call.request.signal instanceof AbortSignal),
    'every broadcast send carries the caller signal the domain requires',
  )
  check(
    broadcast.payload.sent === 2 && broadcast.payload.accepted === 2 && broadcast.payload.failed.length === 0,
    'broadcast reports each delivery (' + JSON.stringify(broadcast.payload.sent) + ')',
  )
  const broadcastEmpty = await onAct({ action: 'broadcast', leadId: 'session-a', message: '' })
  check(broadcastEmpty.status === 400, 'an empty broadcast is refused (' + broadcastEmpty.status + ')')

  const stop = await onAct({ action: 'interrupt', leadId: 'session-a', target: 'alpha' })
  check(stop.status === 200 && stop.payload.previousStatus === 'running', 'interrupt reports the status it saw (got ' + JSON.stringify(stop.payload && stop.payload.previousStatus) + ')')
  const stopCall = on.calls.mutations.find((call) => call.op === 'interrupt')
  check(stopCall && stopCall.target === 'alpha', 'interrupt passes the target name through')

  const done = await onAct({ action: 'task', op: 'complete', leadId: 'session-a', taskId: 'task-5', expectedRevision: 1 })
  check(done.status === 200 && done.payload.ok === true, 'task complete succeeds (got ' + done.status + ')')
  const taskCall = on.calls.mutations.find((call) => call.op === 'updateTask')
  check(
    taskCall && JSON.stringify(taskCall.request) === JSON.stringify({ taskId: 'task-5', expectedRevision: 1, action: 'complete' }),
    'task complete is a compare-and-set on the revision the panel displayed (got ' + JSON.stringify(taskCall && taskCall.request) + ')',
  )

  // Every refusal is a 400/403/404/409, never a 200 and never a mutation.
  const before = on.calls.mutations.length
  const badCalls = [
    [{ action: 'nope', leadId: 'session-a' }, 400, 'unknown action is 400'],
    [{ action: 'wake', leadId: 'session-a' }, 400, 'a wake without a target is 400'],
    [{ action: 'wake', target: 'beta' }, 400, 'a wake without a leadId is 400'],
    [{ action: 'wake', leadId: 'session-zzz', target: 'beta' }, 400, 'a lead that is not live is refused'],
    [{ action: 'task', op: 'complete', leadId: 'session-a', taskId: 'nope', expectedRevision: 1 }, 400, 'a task id outside task-N is 400'],
    [{ action: 'task', op: 'complete', leadId: 'session-a', taskId: 'task-5' }, 400, 'a task action without expectedRevision is 400'],
    [{ action: 'task', op: 'steal', leadId: 'session-a', taskId: 'task-5', expectedRevision: 1 }, 400, 'an unknown task op is 400'],
  ]
  for (const [payload, expected, label] of badCalls) {
    const result = await onAct(payload)
    check(result.status === expected, label + ' (got ' + result.status + ')')
  }
  check(on.calls.mutations.length === before, 'no refused call reached a domain method')

  // A teammate session cannot act as its own lead.
  const notLead = makeWorld({ notALead: true })
  notLead.addLead({ session: session('session-x', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
  const notLeadBoot = boot(notLead, { defectLogs: [], allowMutations: true })
  const notLeadRpc = notLeadBoot.rpc
  const notLeadAct = (payload) => notLeadRpc('act', JSON.stringify({ method: 'act', args: payload }))
  const stolen = await notLeadAct({ action: 'wake', leadId: 'session-x', target: 'beta' })
  check(stolen.status === 400, 'a session that is not the lead cannot act (got ' + stolen.status + ')')
  check(notLead.calls.mutations.length === 0, 'the non-lead path reaches no domain method')
}

// ---------------------------------------------------- branch rows in the card --
// The chip says "81 branches" and the owner cannot open it. The rows behind the
// number must come with the number, labelled from the projection cache the
// sidebar reads.
{
  console.log('card lineage rows')
  const world = makeWorld()
  world.addLead({ session: session('session-lead', 1761000000000), tasks: SIX_TASKS, members: ROSTER })

  // 25 children: three share a truncated title (the projection truncates a long
  // title to a fixed prefix), one has no title at all, one is running.
  const shared = 'Build a new local DSH'
  for (let index = 0; index < 25; index += 1) {
    const id = 'session-child-' + String(index).padStart(2, '0')
    world.addChild('session-lead', { id, createdAt: 1761000000000 + index * 60000, isSeeded: true })
    if (index < 3) world.setTitle(id, shared)
    else if (index === 3) {
      /* deliberately no title */
    } else world.setTitle(id, 'Branch ' + index)
  }
  const runningWorld = world
  runningWorld.addChild('session-lead', { id: 'session-live', createdAt: 1761000600000, origin: 'subagent' })
  runningWorld.setTitle('session-live', 'Live subagent')
  runningWorld.agents.set('session-live', lead('session-live', 'running', 1761000600000))

  const booted = boot(world, { defectLogs: [] })
  const state = await booted.rpc('state')
  const team = state.payload.teams[0]
  const lineage = team.lineage

  check(lineage.state === 'ok', 'lineage is readable')
  check(lineage.branches === 26, 'the count still covers every branch (got ' + lineage.branches + ')')
  check(lineage.rows.length === 20, 'the rows are bounded to 20 (got ' + lineage.rows.length + ')')
  check(
    Array.isArray(lineage.children) && lineage.children.length === lineage.rows.length,
    'the rows are also exposed as `children`, the name the board task asks for',
  )
  check(lineage.truncated === true, 'truncated is set when branches exceed the rows')

  const first = lineage.rows[0]
  check(typeof first.sessionId === 'string' && first.sessionId !== '', 'a row carries its session id')
  check(
    ['title', 'title+disambiguated', 'session-id'].includes(first.labelSource),
    'a row names its label source (got ' + first.labelSource + ')',
  )
  check(
    lineage.rows.slice(0, 3).every((row) => row.labelSource === 'title+disambiguated'),
    'siblings sharing a truncated title are disambiguated',
  )
  check(
    lineage.rows.slice(0, 3).every((row) => row.label.indexOf(shared + ' \u00b7 ') === 0 && row.label.length === shared.length + 7),
    'a disambiguated label is the title plus a 4-character id suffix (got ' + JSON.stringify(lineage.rows.slice(0, 3).map((row) => row.label)) + ')',
  )
  check(
    new Set(lineage.rows.slice(0, 3).map((row) => row.label)).size === 3,
    'three siblings with the same title produce three distinct labels',
  )
  const unlabeled = lineage.rows.find((row) => row.sessionId === 'session-child-03')
  check(unlabeled !== undefined, 'the child with no cached title still gets a row')
  check(
    unlabeled !== undefined && unlabeled.labelSource === 'session-id' && unlabeled.label.indexOf('session ') === 0,
    'a row with no label prints its short session id (got ' + (unlabeled && unlabeled.label) + ')',
  )
  check(
    lineage.rows.every((row) => typeof row.label === 'string' && row.label !== '' && row.label !== 'blank'),
    'no row ever renders the word "blank" as its label',
  )
  check(
    lineage.rows.every((row) => ['running', 'inactive', 'blank', 'unlabeled'].includes(row.state)),
    'every row carries a three-valued state',
  )
  check(
    lineage.rows.every((row) => row.ageSeconds === null || (typeof row.ageSeconds === 'number' && row.ageSeconds >= 0)),
    'every row carries an age or null, never a negative',
  )
}

{
  // Same lead, no projection cache at all: the rows must still exist and name
  // their sessions, not collapse to an empty list.
  const world = makeWorld({ noProjectionCache: true })
  world.addLead({ session: session('session-lead', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
  world.addChild('session-lead', { id: 'session-abc12345', createdAt: 1761000000000, isSeeded: true })
  const booted = boot(world, { defectLogs: [] })
  const state = await booted.rpc('state')
  const lineage = state.payload.teams[0].lineage
  check(lineage.rows.length === 1, 'without a projection cache the rows are still listed')
  check(lineage.rows[0].labelSource === 'session-id', 'without a projection cache the label source says so')
  check(lineage.rows[0].label === 'session abc12345', 'the short label drops the durable id prefix (got ' + lineage.rows[0].label + ')')
}

{
  // A cache that throws must not take the card down.
  const world = makeWorld({ throwProjectionCache: true })
  world.addLead({ session: session('session-lead', 1761000000000), tasks: SIX_TASKS, members: ROSTER })
  world.addChild('session-lead', { id: 'session-abc12345', createdAt: 1761000000000, isSeeded: true })
  const booted = boot(world, { defectLogs: [] })
  const state = await booted.rpc('state')
  const lineage = state.payload.teams[0].lineage
  check(state.payload.ok === true, 'a throwing projection cache does not fail the panel')
  check(lineage.state === 'ok', 'lineage still reads ok when only labels failed')
  check(
    lineage.rows[0] !== undefined && lineage.rows[0].labelSource === 'session-id',
    'an unreadable title falls back to the session id',
  )
  check(
    typeof lineage.reason === 'string' && lineage.reason.indexOf('could not be read') >= 0,
    'the unreadable titles are reported, not swallowed (got ' + lineage.reason + ')',
  )
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
} catch {
  /* best effort */
}

console.log('')
if (failures === 0) {
  console.log('PASS — host half reports the four views, with every absence named')
} else {
  console.log('FAIL — ' + failures + ' check(s) failed')
  process.exit(1)
}
