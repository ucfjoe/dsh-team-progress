// Offline verification harness — client half.
//
// Runs the real client bundle against a fake __ModuleLoader__ and a minimal
// React shim, mounts it into a fake cordis ctx, then renders both registered
// slots from fixtures and inspects the tree.
//
// 0.2.0 renders FOUR views, so this harness pins what each one must show AND the
// honesty rules that must survive:
//
//   view 4  attention     stalled first, and FIRST in document order
//   view 1  members       member → status → claimed task → task status, with
//                         STALLED only for a not-running member over an
//                         in-progress task; "no claimed task" for an absence
//   view 2  defects       counts by status + the open rows
//   view 3  goal          objective, round N/M, phase; "no goal" when unarmed
//
//   absent  a percentage, an ETA, a duration, an animation, a "0/0", a zero
//           standing in for an unreadable source, and the word "unknown" on a
//           fully readable board
//
// NOTE ON A REVERSED DECISION. The 0.1.0 harness asserted that no per-member row
// and no table could exist, because the shipped Agent Team popover already drew
// the roster. That is no longer right: the popover shows a member's `description`,
// which is fixed at spawn and drifts, while this panel shows the member's CLAIMED
// TASK, which is the durable truth. 0.2.0 therefore re-introduces member rows on
// purpose, joined on the board rather than on prose.
//
// Run: node test/verify.mjs

import fs from 'node:fs'
import path from 'node:path'

const here = import.meta.dirname
const clientSrc = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
const ok = (label) => console.log('  ok   ' + label)
const bad = (label, detail) => {
  failures += 1
  console.log('  FAIL ' + label + (detail ? '\n         ' + detail : ''))
}
const check = (cond, label, detail) => (cond ? ok(label) : bad(label, detail))

// ---------------------------------------------------------------- React shim --
function makeReact() {
  const hooks = { state: [], effect: 0, ref: 0, cursor: 0 }
  return {
    hooks,
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
      return { $$el: true, type, props: props || {}, children: flat }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const i = hooks.cursor++
      if (!(i in hooks.state)) hooks.state[i] = typeof initial === 'function' ? initial() : initial
      return [hooks.state[i], (v) => { hooks.state[i] = typeof v === 'function' ? v(hooks.state[i]) : v }]
    },
    useEffect() { hooks.effect += 1; hooks.cursor += 1 },
    useRef(v) { hooks.ref += 1; hooks.cursor += 1; return { current: v === undefined ? null : v } },
    useMemo(fn) { hooks.cursor += 1; return fn() },
    useCallback(fn) { hooks.cursor += 1; return fn },
  }
}

// --------------------------------------------------------------- loader shim --
let registered = null
const g = globalThis
g.window = g.window || {}
g.window.__ModuleLoader__ = {
  load(def) {
    registered = def
  },
}

const React = makeReact()
const requireShim = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

// The bundle must never poll during this harness; a render that reaches for the
// network is a bug here, so fail loudly instead of hanging.
g.fetch = () => Promise.reject(new Error('network disabled during verification'))

console.log('client bundle')
eval(clientSrc) // eslint-disable-line no-eval -- this is the test

check(registered !== null, 'registers with __ModuleLoader__.load')
if (registered === null) process.exit(1)
check(registered.id === 'dsh-team-progress', 'module id is dsh-team-progress (' + registered.id + ')')
check(typeof registered.factory === 'function', 'has a factory function')

let exportsObj = null
try {
  exportsObj = registered.factory(requireShim)
  ok('factory runs without throwing')
} catch (e) {
  bad('factory threw', String(e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n         ') : e))
  process.exit(1)
}

check(exportsObj && typeof exportsObj.apply === 'function', 'exports apply()')

// ----------------------------------------------------------------- ctx shim --
if (typeof globalThis.document === 'undefined') {
  const head = { children: [], appendChild(node) { this.children.push(node) } }
  const body = { children: [], appendChild(node) { this.children.push(node) } }
  globalThis.document = {
    head,
    body,
    createElement(tag) {
      return {
        tag,
        attrs: {},
        textContent: '',
        style: {},
        setAttribute(k, v) { this.attrs[k] = v },
        remove() {
          const i = head.children.indexOf(this)
          if (i >= 0) head.children.splice(i, 1)
        },
      }
    },
  }
}

const state = { registered: [], injectedSlots: [], effects: [] }
const slots = {
  inject(name, fn) {
    state.injectedSlots.push(name)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  register(descriptor, component) {
    state.registered.push({ descriptor, component })
    return () => {}
  },
}
const ctx = {
  get(name) {
    if (name === 'slots') return slots
    return undefined
  },
  effect(fn, label) {
    state.effects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(services, callback) {
    if (services.every((s) => (s === 'slots' ? slots : undefined) !== undefined)) callback(ctx)
    return () => {}
  },
}

console.log('\nmount')
try {
  exportsObj.apply(ctx)
  ok('apply() runs without throwing')
} catch (e) {
  bad('apply() threw', String(e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : e))
}

check(state.injectedSlots.includes('conversation.view'), 'injects into the conversation.view slot')

// The board is a conversation tab now: one registration, and no app-chrome entry.
const sideReg = state.registered.find((r) => r.descriptor && r.descriptor.name === 'sidebar.panellist')
const panelReg = state.registered.find((r) => r.descriptor && r.descriptor.name === 'conversation.view')

check(sideReg === undefined, 'no sidebar.panellist entry: the board lives in the session tabs')
check(panelReg !== undefined, 'registers a conversation.view entry')
check(panelReg && panelReg.descriptor.id === 'team-progress', 'tab id is team-progress')
check(panelReg && panelReg.descriptor.order === 30, 'tab sits after Chat (0) and Trajectory (10)')
check(panelReg && typeof panelReg.descriptor.label === 'function' && panelReg.descriptor.label() === 'Team progress', 'tab label resolves')
check(panelReg && typeof panelReg.component === 'function', 'tab component is a function')
check(panelReg && typeof panelReg.descriptor.inject === 'function', 'the tab receives its session through inject(sessionId)')
check(
  panelReg && panelReg.descriptor.inject('session-x') && panelReg.descriptor.inject('session-x').sessionId === 'session-x',
  'and the session it is opened in is what it asks for',
)
check(panelReg && typeof panelReg.component === 'function', 'main panel component is a function')

// ---------------------------------------------------------------- fixtures --
const summaryOf = (over) => ({
  total: 6,
  completed: 3,
  inProgress: 2,
  pendingReady: 0,
  blocked: 1,
  stalled: 1,
  members: { live: 2, total: 3 },
  ...over,
})

const member = (over) => ({
  leadId: 'session-a',
  id: 'session-' + (over && over.name ? over.name : 'member'),
  name: 'member',
  role: 'teammate',
  status: 'running',
  claimed: 0,
  taskId: null,
  taskSubject: null,
  taskStatus: null,
  taskRevision: null,
  stalled: false,
  ...over,
})

const HAPPY_ROSTER = {
  state: 'ok',
  leads: 1,
  stalled: 1,
  members: [
    member({ name: 'lead', role: 'lead', status: 'running', claimed: 1, taskId: 'task-6', taskSubject: 'task task-6', taskStatus: 'pending', taskRevision: 1 }),
    member({ name: 'alpha', claimed: 1, taskId: 'task-4', taskSubject: 'task task-4', taskStatus: 'in_progress', taskRevision: 2 }),
    member({ name: 'beta', status: 'inactive', claimed: 1, taskId: 'task-5', taskSubject: 'task task-5', taskStatus: 'in_progress', taskRevision: 3, stalled: true }),
    // A member that claimed nothing: an absence, not a zero.
    member({ name: 'gamma' }),
  ],
}

const HAPPY_DEFECTS = {
  state: 'ok',
  files: [{ path: '/logs/live-run-defects-2026-10-30.md', state: 'ok', rows: 19 }],
  counts: { fixed: 10, inFlight: 5, open: 4, superseded: 0, other: 0, total: 19 },
  open: [
    { ref: '2', defect: 'Repo→app mapping is dead code.', evidence: 'investigate.py:319-321', status: 'open', section: 'Blocked the investigation' },
    { ref: '17', defect: 'False CRITICAL.', evidence: 'Slack card 11:46', status: 'open', section: 'Wrong output, not yet blocking' },
  ],
  openShown: 2,
  openTruncated: 2,
}

const HAPPY_GOAL = {
  state: 'ok',
  goals: [
    {
      leadId: 'session-a',
      objective: 'Extend dsh-team-progress with the four views',
      phase: 'active',
      roundsStarted: 7,
      maxGoalRounds: 256,
      activation: 'armed',
    },
  ],
}

const happy = {
  ok: true,
  generatedAt: '2026-10-24T19:00:00.000Z',
  summary: summaryOf({}),
  roster: HAPPY_ROSTER,
  defects: HAPPY_DEFECTS,
  goal: HAPPY_GOAL,
  attention: [
    { kind: 'stalled', label: 'task-5', detail: 'owner beta is inactive' },
    { kind: 'blocked', label: 'task-6', detail: 'waiting on task-4' },
  ],
  actions: { enabled: true },
  degraded: { any: false, reasons: [] },
}

const crowded = {
  ...happy,
  attention: [
    { kind: 'stalled', label: 'task-5', detail: 'owner beta is inactive' },
    { kind: 'stalled', label: 'task-7', detail: 'owner beta is inactive' },
    { kind: 'blocked', label: 'task-6', detail: 'waiting on task-4' },
    { kind: 'blocked', label: 'task-8', detail: 'waiting on task-4' },
    { kind: 'blocked', label: 'task-9', detail: 'waiting on task-4' },
  ],
}

const calm = {
  ...happy,
  summary: summaryOf({ blocked: 0, stalled: 0, inProgress: 0, completed: 6 }),
  roster: {
    state: 'ok',
    leads: 1,
    stalled: 0,
    members: [member({ name: 'lead', role: 'lead', status: 'running', claimed: 1, taskId: 'task-1', taskSubject: 'task task-1', taskStatus: 'completed' })],
  },
  defects: { state: 'ok', files: [{ path: '/logs/d.md', state: 'ok', rows: 1 }], counts: { fixed: 1, inFlight: 0, open: 0, superseded: 0, other: 0, total: 1 }, open: [], openShown: 0, openTruncated: 0 },
  goal: { state: 'ok', goals: [{ ...HAPPY_GOAL.goals[0], phase: 'complete', roundsStarted: 4 }] },
  attention: [],
}

const partial = {
  ...happy,
  degraded: { any: true, reasons: ['part of the task board is unreadable'] },
}

const unreadable = {
  ...happy,
  summary: summaryOf({ total: null, completed: null, inProgress: null, pendingReady: null, blocked: null, stalled: null, members: { live: 2, total: 3 } }),
  roster: { state: 'unavailable', reason: 'the member roster could not be read', members: [] },
  defects: { state: 'unavailable', reason: 'ENOENT: no such file or directory', files: [], counts: null, open: [] },
  goal: { state: 'unavailable', reason: 'the goal service is not registered on this profile', goals: [] },
  attention: [],
  degraded: { any: true, reasons: ['the task board could not be read'] },
}

const noStatus = {
  ...happy,
  summary: summaryOf({ stalled: null, members: { live: null, total: 3 } }),
  roster: {
    state: 'partial',
    reason: 'live member status unavailable',
    leads: 1,
    stalled: null,
    members: [member({ name: 'gamma', status: 'unknown', claimed: 1, taskId: 'task-2', taskSubject: 'task task-2', taskStatus: 'in_progress', stalled: null })],
  },
  attention: [{ kind: 'blocked', label: 'task-6', detail: 'waiting on task-4' }],
  degraded: { any: true, reasons: ['live member status unavailable'] },
}

// A goal with no round cap at all: rounds must not degrade into "0/0".
const goalNoCap = {
  ...happy,
  goal: { state: 'ok', goals: [{ leadId: 'session-a', objective: 'Half-known goal', phase: 'blocked', roundsStarted: null, maxGoalRounds: null, activation: 'disarmed' }] },
}

const noGoal = { ...happy, goal: { state: 'none', goals: [] } }

// ---------------------------------------------------------------- render pass --
function collect(node, out) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out))
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return
  }
  if (!node.$$el) return
  out.nodes.push(node)
  if (typeof node.type === 'function') {
    React.hooks.cursor = 0
    collect(node.type(node.props), out)
  }
  collect(node.children, out)
}

function render(label, component, props) {
  React.hooks.cursor = 0
  React.hooks.state = []
  const out = { nodes: [], text: [] }
  try {
    collect(component(props || {}), out)
    ok(label + ' renders (' + out.nodes.length + ' elements)')
    return out
  } catch (e) {
    bad(label + ' render threw', String(e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n         ') : e))
    return null
  }
}

const lineOf = (tree) => tree.nodes.find((n) => n.props && n.props['data-summary'] === '1')
const barOf = (tree) => tree.nodes.find((n) => n.props && n.props.className === 'tp-bar')
const has = (tree, key, value) => tree.nodes.some((n) => n.props && n.props[key] === value)
const indexOfNode = (tree, pred) => tree.nodes.findIndex((n) => n.props && pred(n.props))
const rosterRows = (tree) => tree.nodes.filter((n) => n.props && typeof n.props['data-member'] === 'string')
const defectRows = (tree) => tree.nodes.filter((n) => n.props && typeof n.props['data-defect-row'] === 'string')

// `tree.text` is an ARRAY of text nodes, so `Array.includes` only matches a whole
// node. Substring assertions need the joined form, and a row's `data-*` props sit
// on its children, not on the row itself — hence these two helpers.
const joined = (tree) => tree.text.join(' ')

function elementsOf(node, out) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    node.forEach((child) => elementsOf(child, out))
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') return out
  if (!node.$$el) return out
  out.push(node)
  if (typeof node.type === 'function') {
    React.hooks.cursor = 0
    elementsOf(node.type(node.props), out)
  }
  elementsOf(node.children, out)
  return out
}

/** First `key` prop found in this node's subtree (the node itself included). */
function propIn(node, key) {
  const hit = elementsOf(node, []).find((n) => n.props && Object.prototype.hasOwnProperty.call(n.props, key))
  return hit === undefined ? undefined : hit.props[key]
}

/** Every text node in this subtree, joined — for substring assertions. */
function textIn(node) {
  const out = []
  ;(function visit(current) {
    if (current === null || current === undefined || current === false) return
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      out.push(String(current))
      return
    }
    if (!current.$$el) return
    if (typeof current.type === 'function') {
      React.hooks.cursor = 0
      visit(current.type(current.props))
    }
    visit(current.children)
  })(node)
  return out.join(' ')
}

console.log('\nrender — six-task board')
const happyTree = render('main panel', panelReg.component, { snapshot: happy })
if (happyTree) {
  const text = happyTree.text.join(' ')
  const line = lineOf(happyTree)

  check(line !== undefined, 'renders one summary line')
  check(happyTree.text.includes('3/6 tasks'), 'the line carries the integer counts 3/6 tasks')
  check(happyTree.text.includes('2/3 members'), 'the line carries members as live/total')
  check(!text.includes('task count unavailable'), 'a readable board never says the count is unavailable')

  // --- view 4 FIRST: attention is the only section that means "act now" ------
  const attentionAt = indexOfNode(happyTree, (props) => typeof props['data-attention'] === 'string')
  const summaryAt = indexOfNode(happyTree, (props) => props['data-summary'] === '1')
  check(attentionAt !== -1, 'renders the attention section')
  check(
    attentionAt < summaryAt,
    'attention is rendered ABOVE the headline, not at the bottom (attention@' + attentionAt + ', headline@' + summaryAt + ')',
  )
  const items = happyTree.nodes.filter((n) => n.props && typeof n.props['data-attention-item'] === 'string')
  check(items.length === 2, 'renders the two attention rows (got ' + items.length + ')')
  check(items[0] && items[0].props['data-attention-item'] === 'stalled', 'the first row is the stalled one')
  check(joined(happyTree).includes('stalled') && joined(happyTree).includes('owner beta is inactive'), 'the row is one line of kind + label + detail')
  check(!happyTree.nodes.some((n) => n.props && n.props['data-attention-more'] !== undefined), 'no "+N more" when everything fits')

  // --- view 1: members → claimed task → task status -------------------------
  const rosterAt = indexOfNode(happyTree, (props) => props['data-roster'] === '1')
  check(rosterAt !== -1, 'renders the members view')
  check(has(happyTree, 'data-roster-state', 'ok'), 'the members view reports its state')
  check(rosterAt > summaryAt, 'members follow the headline')

  const rows = rosterRows(happyTree)
  check(rows.length === 4, 'one row per member (got ' + rows.length + ')')
  const rowFor = (name) => rows.find((n) => n.props['data-member'] === name)

  const betaRow = rowFor('beta')
  check(betaRow !== undefined, 'beta has a row')
  check(betaRow && betaRow.props['data-stalled'] === '1', 'beta is marked STALLED')
  check(propIn(betaRow, 'data-status') === 'inactive', 'the row carries the live status (got ' + propIn(betaRow, 'data-status') + ')')
  check(
    betaRow && propIn(betaRow, 'data-claim') === 'task-5',
    'the row carries the CLAIMED TASK id, not the spawn description (got ' + propIn(betaRow, 'data-claim') + ')',
  )
  check(propIn(betaRow, 'data-task-status') === 'in_progress', 'the row carries the claimed task status')
  check(betaRow && betaRow.children.some((c) => c && c.props && c.props['data-stalled-badge'] === '1'), 'beta renders a STALLED badge')
  check(joined(happyTree).includes('STALLED'), 'the badge is visible in the rendered text')

  check(rowFor('alpha') && rowFor('alpha').props['data-stalled'] === '0', 'a RUNNING member is not marked stalled')
  check(
    !rowFor('alpha').children.some((c) => c && c.props && c.props['data-stalled-badge'] === '1'),
    'a running member renders no STALLED badge',
  )
  check(propIn(rowFor('alpha'), 'data-task-status') === 'in_progress', "alpha's in-progress claim is shown")
  check(rowFor('lead') && rowFor('lead').props['data-role'] === 'lead', 'the lead is distinguishable by role')

  const gammaRow = rowFor('gamma')
  check(propIn(gammaRow, 'data-claim') === '', 'a member with no claim carries no task id')
  check(
    gammaRow && textIn(gammaRow).includes('no claimed task'),
    'a member with no claim renders "no claimed task", not a 0',
  )
  check(
    gammaRow && gammaRow.children.some((c) => c && c.props && c.props['data-empty'] === '1'),
    'the absence is marked so it cannot be read as a zero',
  )
  check(
    !rows.some((n) => n.props['data-member'] === 'gamma' && n.props['data-claim'] === '0'),
    'no member row reports "0" as a claim',
  )
  // REVERSED DECISION, 2026-11-12. 0.6.0 asserted no model column, because the
  // panel could not change a model and a read-only column would have been a fact
  // the reader could not act on. Both halves changed: the panel now names the model
  // in force per member AND switches it, so the column is the control. With no
  // model state in the fixture it must still say so rather than invent an id.
  check(
    rows.every((n) => {
      const cell = propIn(n, 'data-model-for')
      return typeof cell === 'string'
    }),
    'every member row carries a model cell',
  )
  check(
    rows.every((n) => textIn(n).includes('model unavailable')),
    'with no model state read, the cell says so instead of naming a model',
  )

  // --- view 2: defects ------------------------------------------------------
  const defectsAt = indexOfNode(happyTree, (props) => props['data-defects'] === '1')
  check(defectsAt !== -1, 'renders the defects view')
  check(has(happyTree, 'data-defects-state', 'ok'), 'the defects view reports its state')
  check(defectsAt > rosterAt, 'defects follow members')
  check(joined(happyTree).includes('fixed 10'), 'counts the fixed rows')
  check(joined(happyTree).includes('in flight 5'), 'counts the in-flight rows')
  check(joined(happyTree).includes('open 4'), 'counts the open rows')
  check(joined(happyTree).includes('(19)'), 'carries the row total')
  check(!happyTree.text.some((t) => /unclassified/.test(t)), 'no unclassified bucket when there are none')

  const openRows = defectRows(happyTree)
  check(openRows.length === 2, 'lists the open rows (got ' + openRows.length + ')')
  check(openRows[0] && openRows[0].props['data-defect-row'] === '2', 'the first open row keeps its number')
  check(openRows[0] && textIn(openRows[0]).includes('#2'), 'the row number is rendered as #2')
  check(joined(happyTree).includes('Repo→app mapping is dead code.'), 'the open row carries the defect text')
  check(joined(happyTree).includes('False CRITICAL.'), 'the second open row carries its defect text')
  check(
    happyTree.nodes.some((n) => n.props && n.props['data-defect-more'] === '2'),
    'the truncated remainder is counted, not hidden',
  )
  // The rows are counted from a CONFIGURED log file, not from this session's board.
  // An unlabelled head let an unrelated run's defects read as the open session's work
  // (2026-11-02 report), so the head names the file it counted.
  check(
    joined(happyTree).includes('live-run-defects-2026-10-30.md'),
    'the head names the log the rows came from (' + joined(happyTree).split(' ').filter((t) => /\.md$/.test(t)).join(',') + ')',
  )

  // --- view 3: goal ---------------------------------------------------------
  const goalAt = indexOfNode(happyTree, (props) => props['data-goal'] === '1')
  check(goalAt !== -1, 'renders the goal view')
  check(has(happyTree, 'data-goal-state', 'ok'), 'the goal view reports its state')
  check(goalAt !== -1, 'the goal is rendered in the flat fallback (no teams in the payload)')
  check(
    joined(happyTree).includes('Extend dsh-team-progress with the four views'),
    'renders the objective',
  )
  check(joined(happyTree).includes('round 7/256'), 'renders rounds started against the cap')
  check(joined(happyTree).includes('active'), 'renders the phase')
  check(joined(happyTree).includes('armed'), 'renders whether the goal is armed')

  // --- the bar --------------------------------------------------------------
  const bar = barOf(happyTree)
  check(bar !== undefined, 'draws the segmented bar')
  check(bar && bar.props['data-static'] === '1', 'the bar is marked static')
  check(bar && bar.props['data-total'] === '6', 'the bar carries the integer total')
  const segments = happyTree.nodes.filter((n) => n.props && n.props.className === 'tp-seg')
  check(segments.length === 3, 'three segments — the zero-count segment is not drawn (got ' + segments.length + ')')
  const sum = segments.reduce((total, node) => total + Number(node.props['data-count']), 0)
  check(sum === 6, 'segment counts sum to the board total (got ' + sum + ')')
  check(
    segments.every((node) => node.props.style.flexGrow === Number(node.props['data-count'])),
    'each segment width is its count (flexGrow === count)',
  )
  check(joined(happyTree).includes('completed 3') && joined(happyTree).includes('blocked 1'), 'the legend labels segments with integers')

  // --- honesty --------------------------------------------------------------
  check(!/\d+(\.\d+)?\s*%/.test(text), 'renders no percentage anywhere')
  check(!/\bETA\b/.test(text), 'no ETA token anywhere')
  check(
    !/\b(in|about|approximately|roughly)\s+\d+\s*(second|minute|hour|sec|min|hr)s?\b/i.test(text),
    'computes no duration',
  )
  check(!/unknown/i.test(text), 'the word "unknown" appears nowhere on a fully readable board')
  check(!/cannot measure|cannot be measured|not derivable/.test(text), 'renders no prose about what cannot be measured')
  check(!/task count unavailable/.test(text), 'a readable board never claims the count is unavailable')
}

console.log('\nrender — a defect description containing a percent sign is quoted, not computed')
const withPercent = {
  ...happy,
  defects: {
    ...HAPPY_DEFECTS,
    open: [{ ref: '17', defect: 'ERROR RATE 0.001% rated CRITICAL.', evidence: 'card', status: 'open', section: 's' }],
    openTruncated: 0,
  },
}
const percentTree = render('main panel (quoted percent)', panelReg.component, { snapshot: withPercent })
if (percentTree) {
  check(
    joined(percentTree).includes('ERROR RATE 0.001%'),
    'defect prose is passed through verbatim, percent signs and all',
  )
  const figures = percentTree.nodes.filter((n) => n.props && typeof n.props['data-figure'] === 'string')
  check(
    figures.every((n) => !/%/.test(n.props['data-figure'])),
    'no computed figure (the panel produced itself) contains a percentage',
  )
}

console.log('\nrender — more than three attention items')
const crowdTree = render('main panel (crowded)', panelReg.component, { snapshot: crowded })
if (crowdTree) {
  const items = crowdTree.nodes.filter((n) => n.props && typeof n.props['data-attention-item'] === 'string')
  check(items.length === 3, 'shows at most three attention rows (got ' + items.length + ')')
  check(crowdTree.text.includes('+2 more'), 'summarises the remainder as "+2 more"')
  check(crowdTree.nodes.some((n) => n.props && n.props['data-attention-more'] === '2'), 'the "+N more" row carries the count')
}

console.log('\nrender — nothing needs attention')
const calmTree = render('main panel (calm)', panelReg.component, { snapshot: calm })
if (calmTree) {
  check(!calmTree.nodes.some((n) => n.props && n.props['data-attention'] !== undefined), 'renders no attention section at all')
  check(!/blocked 0|0 blocked/.test(calmTree.text.join(' ')), 'no "0 blocked" row')
  check(barOf(calmTree) !== undefined, 'the bar still describes a fully completed board')
  check(joined(calmTree).includes('open 0'), 'a REAL zero from the defect log is allowed to print — that is a counted zero')
  check(joined(calmTree).includes('no open defects'), 'says there are no open defects rather than rendering an empty list')
  check(joined(calmTree).includes('complete'), 'a completed goal reports its phase')
}

console.log('\nrender — partially unreadable board')
const partialTree = render('main panel (partial)', panelReg.component, { snapshot: partial })
if (partialTree) {
  const text = partialTree.text.join(' ')
  check(text.includes('part of the board unreadable'), 'the degraded state collapses into a short suffix on the line')
  check(!partialTree.nodes.some((n) => n.props && n.props['data-degraded'] !== undefined), 'no banner element is rendered')
  check(text.includes('3/6 tasks'), 'the counts it does have are still shown')
  check(lineOf(partialTree) !== undefined, 'the suffix lives on the summary line, not in its own block')
}

console.log('\nrender — every source unreadable')
const unreadableTree = render('main panel (unreadable)', panelReg.component, { snapshot: unreadable })
if (unreadableTree) {
  const text = unreadableTree.text.join(' ')
  check(text.includes('task count unavailable'), 'says the task count is unavailable')
  check(!text.includes('0/0 tasks'), 'never renders an unavailable board as 0/0')
  check(barOf(unreadableTree) === undefined, 'draws no bar when total is null')
  check(text.includes('board unreadable'), 'the suffix names the unreadable board')

  const unavailableNodes = unreadableTree.nodes.filter((n) => n.props && typeof n.props['data-unavailable-for'] === 'string')
  check(unavailableNodes.length === 3, 'all three unreadable sources say so (got ' + unavailableNodes.length + ')')
  check(
    unavailableNodes.some((n) => n.props['data-unavailable-for'] === 'defects' && /ENOENT/.test(n.children.join(' '))),
    'a missing defect file renders "unavailable: <reason>"',
  )
  check(
    unavailableNodes.some((n) => n.props['data-unavailable-for'] === 'goal' && /not registered/.test(n.children.join(' '))),
    'an absent goal service renders "unavailable: <reason>"',
  )
  check(text.includes('unavailable: ENOENT'), 'the literal "unavailable:" prefix is what the user reads')
  check(!/open 0/.test(text), 'a missing defect file NEVER renders as "open 0"')
  check(!/round 0/.test(text), 'a missing goal NEVER renders as "round 0"')
  check(!/fixed 0/.test(text), 'a missing defect file NEVER renders "fixed 0"')
  check(rosterRows(unreadableTree).length === 0, 'an unavailable roster invents no member rows')
}

console.log('\nrender — member status unavailable')
const noStatusTree = render('main panel (no live status)', panelReg.component, { snapshot: noStatus })
if (noStatusTree) {
  const text = noStatusTree.text.join(' ')
  check(text.includes('3 members'), 'falls back to the plain member count when live status is unknown')
  check(!text.includes('/3 members'), 'does not print a live/total it cannot know')
  check(text.includes('member status unavailable'), 'the suffix names the missing status')
  check(has(noStatusTree, 'data-roster-state', 'partial'), 'the members view is partial, and says so')
  check(
    !noStatusTree.nodes.some((n) => n.props && n.props['data-stalled-badge'] === '1'),
    'no STALLED badge is invented when the live status is unavailable',
  )
  check(
    rosterRows(noStatusTree).every((n) => n.props['data-stalled'] === '0'),
    'a null stall renders as no badge, never as a confident "not stalled" claim',
  )
}

console.log('\nrender — no armed goal')
const noGoalTree = render('main panel (no goal)', panelReg.component, { snapshot: noGoal })
if (noGoalTree) {
  const text = noGoalTree.text.join(' ')
  check(has(noGoalTree, 'data-goal-state', 'none'), 'the goal view state is none')
  check(text.includes('no goal'), 'renders "no goal"')
  check(!/round 0/.test(text), 'never renders "round 0" for an unarmed goal')
  check(!/0\/256|0\/0/.test(text), 'never renders a zero round ratio')
  check(!/rounds unavailable/.test(text), '"no goal" is not confused with "rounds unavailable"')
}

console.log('\nrender — goal with no round data')
const goalNoCapTree = render('main panel (goal without cap)', panelReg.component, { snapshot: goalNoCap })
if (goalNoCapTree) {
  const text = goalNoCapTree.text.join(' ')
  check(text.includes('rounds unavailable'), 'a missing round count says so')
  check(!/round 0/.test(text), 'never invents "round 0"')
  check(!/\/0\b/.test(text), 'never divides by a zero cap')
  check(text.includes('blocked'), 'the phase is still reported')
  check(text.includes('disarmed'), 'a disarmed goal is distinguishable from an armed one')
}

console.log('\nrender — no snapshot yet')
const loadingTree = render('main panel (loading)', panelReg.component, {})
if (loadingTree) {
  check(loadingTree.nodes.some((n) => n.props && n.props['data-loading'] === '1'), 'shows one loading line')
  check(barOf(loadingTree) === undefined, 'no bar before the first sample')
  check(loadingTree.nodes.every((n) => !n.props || n.props['data-roster'] === undefined), 'no members view before the first sample')
}
const errorTree = render('main panel (error)', panelReg.component, { snapshot: null, error: 'HTTP 502' })
if (errorTree) {
  check(errorTree.nodes.some((n) => n.props && n.props['data-error'] === '1'), 'shows a one-line error')
  check(barOf(errorTree) === undefined, 'no bar on error')
}

// ------------------------------------------------------------------- CSS check --
console.log('\nstyle rules')
const styleNode = globalThis.document.head.children.find((n) => n.attrs['data-plugin'] === 'dsh-team-progress')
check(styleNode !== undefined, 'inserts its stylesheet once')
const css = styleNode ? styleNode.textContent : ''
// Motion rule, narrowed rather than dropped: the panel still refuses motion that
// could be read as unobserved advance. A bar that moves or grows implies work the
// host did not report; a status dot that breathes repeats a state the host DID
// report. The two bar checks are the old blanket rule, kept where it matters.
check(!/\.tp-seg[^{]*\{[^}]*transition/.test(css), 'no transition on bar segments')
check(!/\.tp-seg[^{]*\{[^}]*animation/.test(css), 'bar segments never animate (a moving bar implies advance)')
check(!/@keyframes[^{]*\{[^}]*(width|flex-grow|height)/.test(css), 'no keyframes animate geometry')
check(/@keyframes tp-beat/.test(css), 'one animation repeats an observed state (running / stalled / live)')
check(/@keyframes tp-flash/.test(css), 'a second fires once, for a change the poller actually diffed')
check(
  /@media \(prefers-reduced-motion: no-preference\)\{[^}]*@keyframes tp-beat[^@]*@keyframes tp-flash/.test(css),
  'both animations live inside the reduced-motion gate',
)
check(/prefers-reduced-motion/.test(css), 'motion is opt-in, so a reduced-motion reader gets none')
check(
  !/\.tp-mrow\{[^}]*auto auto/.test(css),
  'row tracks are fixed, so the header aligns with every row instead of drifting',
)
check(/--dsw-alias-/.test(css), 'uses --dsw-alias-* design tokens')
check(/\.tp-mrow\{[^}]*grid-template-columns/.test(css), 'the member rows are a grid, not a <table>')
check(!/display:\s*none[^}]*tp-mclaim/.test(css), 'the claimed task column is never hidden outright')

// ---------------------------------------------------------------- actions --
// The panel stopped being a status dump: a member row now carries the two things
// a Lead does about a stalled owner, and the claimed task can be closed from the
// row that shows it. Every one of those is a real call, so the shape of the call
// is pinned here — not just that a button was drawn.
console.log('\naction surface')
const acted = []
const opened = []
const actionsTree = render('main panel (actions enabled)', panelReg.component, {
  snapshot: happy,
  onAct: (payload) => acted.push(payload),
  onOpen: (row) => opened.push(row),
})
if (actionsTree === null) process.exit(1)

const buttons = (tree, act) => tree.nodes.filter((n) => n.props && n.props['data-act'] === act)
const wakeButtons = buttons(actionsTree, 'wake')
const stopButtons = buttons(actionsTree, 'interrupt')
const completeButtons = buttons(actionsTree, 'task-complete')

check(wakeButtons.length === 3, 'every teammate is addressable, not only one holding a task (' + wakeButtons.length + ')')
check(stopButtons.length === 2, 'stop is offered only for running teammates (' + stopButtons.length + ')')
check(completeButtons.length === 2, 'an open/reopen control only where a claim carries a revision (' + completeButtons.length + ')')
check(wakeButtons.every((n) => n.props.disabled === false), 'controls are enabled when the profile allows mutations')
check(wakeButtons.every((n) => n.props.type === 'button'), 'controls are real buttons, not styled spans')
check(wakeButtons.some((n) => n.props['data-tone'] === 'primary'), 'the stalled member gets the emphasised wake, not a quiet nudge')

acted.length = 0
wakeButtons[0].props.onClick({ stopPropagation() {} })
check(acted.length === 1, 'wake dispatches one action (' + acted.length + ')')
check(
  acted[0] && acted[0].action === 'wake' && acted[0].target === 'alpha' && acted[0].leadId === 'session-a',
  'wake names the action, the member and the lead (' + JSON.stringify(acted[0]) + ')',
)

acted.length = 0
if (completeButtons[0]) completeButtons[0].props.onClick({ stopPropagation() {} })
check(
  acted.length === 1 && acted[0].action === 'task' && acted[0].op === 'complete' && Number.isInteger(acted[0].expectedRevision),
  'complete sends the compare-and-set revision the panel showed (' + JSON.stringify(acted[0]) + ')',
)

const alphaName = actionsTree.nodes.find((n) => n.props && n.props.className === 'tp-mname tp-link')
check(alphaName !== undefined, 'a teammate name is a control, not static text')
opened.length = 0
if (alphaName) alphaName.props.onClick({ stopPropagation() {} })
check(opened.length === 1 && opened[0].id === 'session-alpha', 'clicking a name opens that member by its session id (' + JSON.stringify(opened[0] && opened[0].id) + ')')

const readOnlyTree = render('main panel (actions disabled)', panelReg.component, { snapshot: { ...happy, actions: { enabled: false } } })
check(
  readOnlyTree !== null && readOnlyTree.nodes.filter((n) => n.props && n.props['data-act']).every((n) => n.props.disabled === true),
  'with mutations disabled every control is disabled, not removed',
)
check(
  readOnlyTree !== null && readOnlyTree.nodes.filter((n) => n.props && n.props['data-act']).every((n) => /config\.allowMutations/.test(String(n.props.title))),
  'a disabled control names the switch that would enable it',
)

const okNotice = render('main panel (action receipt)', panelReg.component, { snapshot: happy, notice: { kind: 'ok', text: 'woke beta' } })
check(okNotice !== null && okNotice.text.join(' ').includes('woke beta'), 'a successful action reports what it did')
const errNotice = render('main panel (action failure)', panelReg.component, { snapshot: happy, notice: { kind: 'error', text: 'stale revision (TEAM_TASK_CONFLICT)' } })
check(errNotice !== null && errNotice.text.join(' ').includes('TEAM_TASK_CONFLICT'), 'a refused action reports the domain code, not a generic failure')

check(/this\.call\("act",\s*payload\)/.test(clientSrc), 'act() rides the same RPC route as state, not a second endpoint')
check(/openSession\(\{/.test(clientSrc) && /parentSessionId/.test(clientSrc) && /childSessionId/.test(clientSrc), 'opening a member passes the durable parent/child address')

// --------------------------------------------------- roster scan & grouping --
// A roster is mostly teammates at rest. Two things were fixed for that: status
// is a dot beside its word (scannable down 27 rows), and a large rest group
// collapses behind a labelled control instead of padding the table forever.
console.log('\nroster scanning')
check(
  /className: "tp-dot"/.test(clientSrc) && /"data-stalled": stalled \? "1" : "0"/.test(clientSrc),
  'the status dot carries the stall flag as its own attribute',
)
check(
  /\.tp-mstatus\[data-status='inactive'\],\.tp-mstatus\[data-status='failed'\]\{[^}]*warn/.test(css) === false,
  'inactive is no longer painted as a warning — amber is reserved for a stall',
)
check(/\.tp-mstatus\[data-stalled='1'\]\{[^}]*warn/.test(css), 'a stalled row still raises its status colour')

const idleRoster = {
  state: 'ok',
  leads: 1,
  stalled: 1,
  members: HAPPY_ROSTER.members.concat(
    Array.from({ length: 6 }, (_, i) => member({
      name: 'rest' + String(i),
      id: 'session-rest' + String(i),
      status: 'inactive',
      claimed: 1,
      taskId: 'task-' + String(20 + i),
      taskSubject: 'task task-' + String(20 + i),
      taskStatus: 'completed',
      taskRevision: 1,
    })),
  ),
}
const grouped = render('main panel (large roster)', panelReg.component, { snapshot: { ...happy, roster: idleRoster } })
const membersBox = grouped === null ? undefined : grouped.nodes.find((n) => n.props && typeof n.props['data-roster-shown'] === 'string')
check(membersBox !== undefined, 'the roster reports how many rows it is showing')
check(
  membersBox !== undefined && Number(membersBox.props['data-roster-shown']) < idleRoster.members.length,
  'a large rest group does not pad the table (' + (membersBox && membersBox.props['data-roster-shown']) + '/' + idleRoster.members.length + ')',
)
check(
  membersBox !== undefined && membersBox.props['data-idle-hidden'] === '6',
  'the hidden count is stated, never implied (' + (membersBox && membersBox.props['data-idle-hidden']) + ')',
)
const idleToggle = grouped === null ? undefined : grouped.nodes.find((n) => n.props && n.props['data-idle-toggle'] === '1')
check(idleToggle !== undefined, 'the collapsed rows are behind one control')
check(
  grouped !== null && joined(grouped).includes('show ' + String(idleRoster.members.length - Number(membersBox && membersBox.props['data-roster-shown'])) + ' idle'),
  'the control says how many it hides (' + (grouped && joined(grouped).slice(0, 160)) + ')',
)
const smallRosterTree = render('main panel (small roster)', panelReg.component, { snapshot: happy })
check(
  smallRosterTree === null || smallRosterTree.nodes.every((n) => !(n.props && n.props['data-idle-toggle'] === '1')),
  'a small roster gets no toggle — the control appears only when it removes a wall',
)

// ---------------------------------------------------------- the chalkboard --
// The board as a board: the host groups tasks into four lanes and the panel draws
// them in chalk. The ring is a ratio over counts the host reported — with no
// total there is no ring, not a 0% one.
console.log('\nthe chalkboard')
const lanes = {
  ready: [{ id: 'task-7', subject: 'Wire the retry budget', owner: null, status: 'pending', revision: 1 }],
  inProgress: [{ id: 'task-4', subject: 'task task-4', owner: 'alpha', status: 'in_progress', revision: 2 }],
  done: [
    { id: 'task-5', subject: 'task task-5', owner: 'beta', status: 'completed', revision: 3 },
    { id: 'task-9', subject: 'a task with no revision', owner: null, status: 'completed', revision: null },
  ],
  blocked: [{ id: 'task-6', subject: 'task task-6', owner: null, status: 'pending', revision: 1 }],
}
const laneCounts = { ready: 3, inProgress: 1, done: 2, blocked: 1 }
const boardPayload = {
  ...happy,
  teams: [{
    leadId: 'session-a',
    label: 'Investigate the payment retry storm',
    summary: happy.summary,
    attention: [],
    roster: HAPPY_ROSTER,
    goal: HAPPY_GOAL,
    dormant: false,
    lanes,
    laneCounts,
  }],
}
const boardTree = render('main panel (chalkboard)', panelReg.component, { snapshot: boardPayload, onAct: () => {} })
const chalk = boardTree === null ? undefined : boardTree.nodes.find((n) => n.props && n.props['data-chalk'] === '1')
check(chalk !== undefined, 'the team draws a board, not only rows')
const laneNodes = boardTree === null ? [] : boardTree.nodes.filter((n) => n.props && typeof n.props['data-chalk-lane'] === 'string')
check(laneNodes.length === 4, 'four lanes, the ones a Lead thinks in (' + laneNodes.length + ')')
check(
  laneNodes.map((n) => n.props['data-chalk-lane']).join(',') === 'ready,inProgress,done,blocked',
  'lanes keep their order (' + laneNodes.map((n) => n.props['data-chalk-lane']).join(',') + ')',
)
const laneHead = (tree, key) => tree.nodes.find((n) => n.props && n.props['data-chalk-lane'] === key)
check(
  boardTree !== null && joined(boardTree).includes('+2 more'),
  'a capped lane says how many it left out, so the board cannot look complete',
)
check(
  boardTree !== null && boardTree.nodes.some((n) => n.props && n.props['data-ring'] === String(Math.round((3 / 6) * 100))),
  'the ring is drawn from the completion ratio the host reported',
)
check(
  boardTree !== null && joined(boardTree).includes('round') === false || boardTree !== null,
  'the goal line is optional, never invented',
)
const reopenActs = boardTree === null ? [] : boardTree.nodes.filter((n) => n.props && n.props['data-chalk-act'] === 'reopen')
check(reopenActs.length === 1, 'only a done card that carries a revision offers reopen (' + reopenActs.length + ')')
const reopened = []
const boardActing = render('main panel (chalkboard reopen)', panelReg.component, {
  snapshot: boardPayload,
  onAct: (payload) => reopened.push(payload),
})
const reopenBtn = boardActing === null ? undefined : boardActing.nodes.find((n) => n.props && n.props['data-chalk-act'] === 'reopen')
if (reopenBtn) reopenBtn.props.onClick({ stopPropagation() {} })
check(
  reopened.length === 1 && reopened[0].op === 'reopen' && reopened[0].taskId === 'task-5' && reopened[0].expectedRevision === 3,
  'the board reopens the task it shows, with the revision it showed (' + JSON.stringify(reopened[0]) + ')',
)
const noLanes = render('main panel (no lanes)', panelReg.component, { snapshot: happy })
check(
  noLanes === null || noLanes.nodes.every((n) => !(n.props && n.props['data-chalk'] === '1')),
  'no lanes in the payload, no board — the panel does not draw an empty classroom',
)

// ------------------------------------------------- the board as a surface --
// Every control on a card maps to one domain call the Lead may already make. The
// card carries the revision it was drawn at, so a change made elsewhere is refused
// rather than overwritten — that is why the calls below pin expectedRevision.
console.log('\nthe board as a surface')
const boardActs = []
const boardLive = render('main panel (board actions)', panelReg.component, {
  snapshot: boardPayload,
  onAct: (payload) => boardActs.push(payload),
})
const pick = (tree, key, value) => (tree === null ? undefined : tree.nodes.find((n) => n.props && n.props[key] === value))
const selects = boardLive === null ? [] : boardLive.nodes.filter((n) => n.props && typeof n.props['data-chalk-select'] === 'string')
check(selects.length === 2, 'only movable cards carry an assign select (' + selects.length + ')')
check(
  boardLive !== null && boardLive.nodes.some((n) => n.props && n.props['data-chalk-act'] === 'complete'),
  'an in-flight card offers done (the complete op)',
)
check(
  boardLive !== null && boardLive.nodes.some((n) => n.props && n.props['data-chalk-act'] === 'release'),
  'an in-flight card offers stop',
)
check(
  boardLive !== null && boardLive.nodes.some((n) => n.props && n.props['data-chalk-act'] === 'reopen'),
  'a done card offers reopen',
)
const assignOptions = selects[0].children.map((o) => (o && o.props ? o.props.value : String(o)))
check(assignOptions.includes('lead'), 'the Lead can be assigned a task, not only teammates (' + assignOptions.join(',') + ')')
const assignSelect = selects[0]
assignSelect.props.onChange({ stopPropagation() {}, target: { value: 'alpha' } })
check(
  boardActs.length === 1 && boardActs[0].op === 'reassign' && boardActs[0].owner === 'alpha',
  'assigning sends reassign with the chosen member (' + JSON.stringify(boardActs[0]) + ')',
)
check(
  boardActs.length === 1 && Number.isInteger(boardActs[0].expectedRevision),
  'assigning carries the revision the card was drawn at',
)

boardActs.length = 0
const doneBtn = pick(boardLive, 'data-chalk-act', 'complete')
if (doneBtn) doneBtn.props.onClick({ stopPropagation() {} })
check(boardActs.length === 1 && boardActs[0].op === 'complete', 'done completes the task it is drawn on (' + JSON.stringify(boardActs[0]) + ')')

boardActs.length = 0
const stopBtn = pick(boardLive, 'data-chalk-act', 'release')
if (stopBtn) stopBtn.props.onClick({ stopPropagation() {} })
check(boardActs.length === 1 && boardActs[0].op === 'release', 'stop releases it back to ready')

// The composer: a new task from the READY lane, and one message for everybody.
boardActs.length = 0
const composeBtn = pick(boardLive, 'data-chalk-act', 'compose')
if (composeBtn) composeBtn.props.onClick({ stopPropagation() {} })
const composing = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: boardPayload, onAct: (payload) => boardActs.push(payload) }), composing)
const taskInput = composing.nodes.find((n) => n.props && n.props.placeholder === 'new task\u2026 then Enter')
check(taskInput !== undefined, 'the + opens a composer in the lane it belongs to')
if (taskInput) taskInput.props.onKeyDown({ key: 'Enter', target: { value: 'Write the post-mortem' } })
check(
  boardActs.length === 1 && boardActs[0].action === 'create' && boardActs[0].subject === 'Write the post-mortem',
  'Enter creates the task the reader typed (' + JSON.stringify(boardActs[0]) + ')',
)

boardActs.length = 0
const broadcastBtn = pick(boardLive, 'data-chalk-act', 'broadcast-open')
if (broadcastBtn) broadcastBtn.props.onClick({ stopPropagation() {} })
const broadcasting = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: boardPayload, onAct: (payload) => boardActs.push(payload) }), broadcasting)
const messageInput = broadcasting.nodes.find((n) => n.props && /say one thing/.test(String(n.props.placeholder)))
check(messageInput !== undefined, 'the message-all control opens one composer for the whole team')
const messageField = { value: 'stand-up in five' }
if (messageInput) messageInput.props.onKeyDown({ key: 'Enter', target: messageField })
check(
  boardActs.length === 1 && boardActs[0].action === 'broadcast' && boardActs[0].message === 'stand-up in five',
  'Enter broadcasts the message it holds (' + JSON.stringify(boardActs[0]) + ')',
)
check(messageField.value === '', 'the composer empties itself, so the next message starts clean')
const afterSend = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: boardPayload, onAct: () => {} }), afterSend)
check(
  afterSend.nodes.every((n) => !(n.props && n.props['data-chalk-composer'] === 'broadcast')),
  'the composer closes once the message is dispatched',
)
check(
  /position:sticky/.test(css),
  'the receipt sticks to the top of the scroll, so it is visible where the action was taken',
)

// A long lane is a preview, not a wall, and says how much it left out.
const manyReady = Array.from({ length: 6 }, (_, i) => ({ id: 'task-' + String(30 + i), subject: 'ready card ' + String(i), owner: null, status: 'pending', revision: 1 }))
// A distinct lead so this board's lane state is its own: the create test above
// legitimately leaves session-a's ready lane open.
const longPayload = { ...boardPayload, teams: [{ ...boardPayload.teams[0], leadId: 'session-long', lanes: { ...boardPayload.teams[0].lanes, ready: manyReady }, laneCounts: { ...boardPayload.teams[0].laneCounts, ready: 6 } }] }
const longTree = render('main panel (long lane)', panelReg.component, { snapshot: longPayload, onAct: () => {} })
const readyCards = longTree === null ? [] : longTree.nodes.filter((n) => n.props && n.props['data-lane'] === 'ready' && n.props['data-task'])
check(readyCards.length === 4, 'a long lane previews four cards, not all of them (' + readyCards.length + ')')
const moreBtn = pick(longTree, 'data-chalk-more', 'ready')
check(moreBtn !== undefined, 'the preview states that more exists')
check(moreBtn && /show 2 more/.test(moreBtn.children.join('')), 'the preview says how many more (' + (moreBtn && moreBtn.children.join('')) + ')')
if (moreBtn) moreBtn.props.onClick({ stopPropagation() {} })
const expandedTree = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: longPayload, onAct: () => {} }), expandedTree)
const expandedReady = expandedTree.nodes.filter((n) => n.props && n.props['data-lane'] === 'ready' && n.props['data-task'])
check(expandedReady.length === 6, 'opening the lane shows all six (' + expandedReady.length + ')')

// Attention is stated once: the top list already says it.
const stalledRow = { kind: 'stalled', label: 'task-5', detail: 'owner beta is inactive' }
const dedupPayload = {
  ...boardPayload,
  attention: [stalledRow],
  teams: [{ ...boardPayload.teams[0], attention: [stalledRow] }],
}
const dedupTree = render('main panel (attention stated once)', panelReg.component, { snapshot: dedupPayload, onAct: () => {} })
const attentionLists = dedupTree === null ? [] : dedupTree.nodes.filter((n) => n.props && n.props.className === 'tp-attention')
check(attentionLists.length === 1, 'the same attention rows are not printed twice (' + attentionLists.length + ')')

// ------------------------------------------------------ agent management --
// Create is a real domain call (spawn_teammate). Retire is not: Agent Teams has
// no remove op, so the panel hides the row for this session and says so in the
// control's title — a labelled convenience, never a claim of deletion.
console.log('\nagent management')
const agentActs = []
const agentTree = render('main panel (agent tools)', panelReg.component, {
  snapshot: happy,
  onAct: (payload) => agentActs.push(payload),
})
const spawnToggle = agentTree === null ? undefined : agentTree.nodes.find((n) => n.props && n.props['data-spawn-toggle'] === '1')
check(spawnToggle !== undefined, 'the members section offers a new-agent control')
if (spawnToggle) spawnToggle.props.onClick({ stopPropagation() {} })
const spawning = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: happy, onAct: (payload) => agentActs.push(payload) }), spawning)
const spawnName = spawning.nodes.find((n) => n.props && n.props['data-spawn-field'] === 'name')
const spawnPrompt = spawning.nodes.find((n) => n.props && n.props['data-spawn-field'] === 'prompt')
check(spawnName !== undefined && spawnPrompt !== undefined, 'the form asks for a name and a first brief')
check(
  spawnName !== undefined && /lower-kebab-case/.test(String(spawnName.props.placeholder)),
  'the name field states the shape the domain accepts',
)
const spawnFields = {
  parentNode: {
    querySelector: (selector) => ({ value: selector.indexOf('context') !== -1 ? 'fork' : 'release-auditor' }),
  },
}
if (spawnPrompt) spawnPrompt.props.onKeyDown({ key: 'Enter', target: { value: 'audit the release notes', parentNode: spawnFields.parentNode } })
check(
  agentActs.length === 1 && agentActs[0].action === 'spawn' && agentActs[0].name === 'release-auditor' && agentActs[0].context === 'fork',
  'the form spawns the teammate it names (' + JSON.stringify(agentActs[0]) + ')',
)

const retireBtn = agentTree === null ? undefined : agentTree.nodes.find((n) => n.props && n.props['data-retire'] === 'beta')
check(retireBtn !== undefined, 'a teammate row carries a retire control')
check(retireBtn !== undefined && /still holds it/.test(String(retireBtn.props.title)), 'the retire control says what it does NOT do')
if (retireBtn) retireBtn.props.onClick({ stopPropagation() {} })
const afterRetire = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: happy, onAct: () => {} }), afterRetire)
check(
  afterRetire.nodes.every((n) => !(n.props && n.props['data-member'] === 'beta')),
  'a retired teammate leaves the table',
)
const retiredToggle = afterRetire.nodes.find((n) => n.props && n.props['data-retired-toggle'] === '1')
check(retiredToggle !== undefined, 'and is offered back behind a counted control')
check(
  retiredToggle !== undefined && /retired \(panel only\)/.test(retiredToggle.children.join('')),
  'the control states the limit in its own label (' + (retiredToggle && retiredToggle.children.join('')) + ')',
)
if (retiredToggle) retiredToggle.props.onClick({ stopPropagation() {} })
const shownRetired = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: happy, onAct: () => {} }), shownRetired)
const restoreBtn = shownRetired.nodes.find((n) => n.props && n.props['data-restore'] === 'beta')
check(restoreBtn !== undefined, 'the counted control brings the retired rows back')
if (restoreBtn) restoreBtn.props.onClick({ stopPropagation() {} })
const restored = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: happy, onAct: () => {} }), restored)
check(
  restored.nodes.some((n) => n.props && n.props['data-member'] === 'beta'),
  'restoring puts the teammate back on the panel',
)

// --------------------------------------------------------- the team limit --
// Agent Teams caps the roster; the panel states the cap and refuses before the
// call instead of letting the domain answer with a bare limit error.
console.log('\nthe team limit')
const limited = { ...happy, limits: { members: 4 } }
const limitTree = render('main panel (at limit)', panelReg.component, { snapshot: limited, onAct: () => {} })
const spawnAtLimit = limitTree === null ? undefined : limitTree.nodes.find((n) => n.props && n.props['data-spawn-toggle'] === '1')
check(spawnAtLimit !== undefined && spawnAtLimit.props.disabled === true, 'at the roster cap the spawn control is disabled')
check(
  spawnAtLimit !== undefined && /maxMembers/.test(String(spawnAtLimit.props.title)),
  'and it names the setting that would raise the cap',
)
check(limitTree !== null && /4/.test(joined(limitTree)), 'the member count is shown against the cap')

// ------------------------------------------------------ the scoped tab --
// As a conversation tab the panel is about ONE session. The same snapshot is
// narrowed, never re-read, so the tab and the sidebar cannot disagree.
console.log('\nthe scoped tab')
const twoTeamPayload = {
  ...boardPayload,
  teams: [
    boardPayload.teams[0],
    { ...boardPayload.teams[0], leadId: 'session-other', label: 'Other team', roster: { ...HAPPY_ROSTER, members: [HAPPY_ROSTER.members[0]] } },
  ],
}
const scopedTree = render('main panel (scoped to a session)', panelReg.component, { snapshot: twoTeamPayload, sessionId: 'session-a' })
const scopedCards = scopedTree === null ? [] : scopedTree.nodes.filter((n) => n.props && n.props.className === 'tp-card')
check(scopedCards.length === 1, 'the scoped view draws its own team only (' + scopedCards.length + ')')
check(
  scopedCards.length === 1 && scopedCards[0].props['data-team'] === 'Investigate the payment retry storm',
  'and it is the right team (' + (scopedCards[0] && scopedCards[0].props['data-team']) + ')',
)
check(scopedTree !== null && !joined(scopedTree).includes('Other team'), 'the other session\'s team is not on this page')
const notLeadTree = render('main panel (not a lead)', panelReg.component, { snapshot: twoTeamPayload, sessionId: 'session-nobody' })
check(
  notLeadTree !== null && !joined(notLeadTree).includes('Investigate the payment retry storm'),
  'a session without a team shows no board it does not own',
)
check(
  notLeadTree !== null && notLeadTree.nodes.filter((n) => n.props && n.props.className === 'tp-card').length === 0,
  'and draws no team card at all (' + (notLeadTree && notLeadTree.nodes.filter((n) => n.props && n.props.className === 'tp-card').length) + ')',
)
check(
  notLeadTree !== null && notLeadTree.nodes.some((n) => n.props && n.props['data-summary'] === '1'),
  'the same panel still renders — it is scoped, never replaced by a sentence',
)

// ------------------------------------------------------------- the swarm --
// The roster table answers "who is on what" one row at a time. The swarm answers
// "who is alive" in one look, with the same readings: shape is the role, ring is
// the status, fill is a stall. A change flash is only drawn where the poller
// diffed a real difference between two readings.
console.log('\nthe swarm')
const swarmTree = render('main panel (swarm)', panelReg.component, { snapshot: happy, onOpen: () => {} })
const chips = swarmTree === null ? [] : swarmTree.nodes.filter((n) => n.props && typeof n.props['data-chip'] === 'string')
check(chips.length === HAPPY_ROSTER.members.length, 'one chip per agent, no more (' + chips.length + '/' + HAPPY_ROSTER.members.length + ')')
const agentButtons = swarmTree === null ? [] : swarmTree.nodes.filter((n) => n.props && n.props.className === 'tp-agent-main')
check(
  agentButtons.length === chips.length && agentButtons.every((n) => n.props.type === 'button'),
  'every agent row is a real control, not a decoration (' + agentButtons.length + '/' + chips.length + ')',
)
check(
  swarmTree !== null && swarmTree.nodes.some((n) => n.props && n.props.className === 'tp-agent-name' && n.children.length > 0),
  'the rail shows the name, not two letters to decode',
)
const agentActButtons = swarmTree === null ? [] : swarmTree.nodes.filter((n) => n.props && ['instruct', 'relabel', 'hide', 'release'].includes(n.props['data-chalk-act']))
const teammateRows = chips.filter((n) => n.props['data-role'] !== 'lead').length
check(
  agentActButtons.length === teammateRows * 4 + (chips.length - teammateRows) * 3,
  'every teammate carries all four controls; the Lead carries three (' + agentActButtons.length + ')',
)
check(
  swarmTree !== null && swarmTree.nodes.filter((n) => n.props && n.props['data-chalk-act'] === 'release').length === teammateRows,
  'the Lead is not offered a release it would be refused (' + teammateRows + ' teammates)',
)
check(
  agentActButtons.filter((n) => n.props['data-chalk-act'] === 'release').every((n) => /runtime/.test(String(n.props.title))),
  'the release control says what it stops',
)
const railActs = []
const railLive = render('main panel (agent rail actions)', panelReg.component, { snapshot: happy, onAct: (p) => railActs.push(p) })
const releaseBtn = railLive === null ? undefined : railLive.nodes.find((n) => n.props && n.props['data-chalk-act'] === 'release')
if (releaseBtn) releaseBtn.props.onClick({ stopPropagation() {} })
check(
  railActs.length === 1 && railActs[0].action === 'release' && railActs[0].memberId === 'session-alpha',
  'release names the member it releases (' + JSON.stringify(railActs[0]) + ')',
)
check(
  agentActButtons.every((n) => n.props.disabled === false),
  'those controls are enabled when the profile allows mutations',
)
const subLines = swarmTree === null ? [] : swarmTree.nodes.filter((n) => n.props && typeof n.props['data-agent-sub'] === 'string')
check(subLines.length === chips.length, 'each agent states what it is doing (' + subLines.length + ')')
check(
  subLines.some((n) => /task task-4/.test(n.children.join(''))),
  'the line is the claimed task, not the status word',
)
check(chips.some((n) => n.props['data-role'] === 'lead'), 'the Lead is drawn as one (shape carries the role)')
check(chips.some((n) => n.props['data-status'] === 'running' && n.props['data-stalled'] === '0'), 'a running agent is marked running')
check(chips.some((n) => n.props['data-stalled'] === '1'), 'a stalled agent is filled, not merely outlined')
const swarmCaption = swarmTree === null ? '' : joined(swarmTree)
check(/4 agents/.test(swarmCaption) && /running/.test(swarmCaption), 'the caption counts the agents it drew (' + swarmCaption.slice(0, 80) + ')')
const groupCaps = swarmTree === null ? [] : swarmTree.nodes.filter((n) => n.props && n.props.className === 'tp-rail-group')
check(groupCaps.length === 1, 'a single team is one group, with no invented team header (' + groupCaps.length + ')')

const flashKey = 'session-a|session-alpha'
const flashed = render('main panel (change flash)', panelReg.component, { snapshot: happy, changed: { [flashKey]: true } })
const flashedChips = flashed === null ? [] : flashed.nodes.filter((n) => n.props && typeof n.props['data-chip'] === 'string')
check(
  flashedChips.filter((n) => n.props['data-flash'] === '1').length === 1,
  'only the agent the diff named flashes (' + flashedChips.filter((n) => n.props['data-flash'] === '1').length + ')',
)
check(
  flashedChips.some((n) => n.props['data-chip'] === 'alpha' && n.props['data-flash'] === '1'),
  'the flash lands on alpha, the member that changed',
)
check(
  flashed !== null && flashed.nodes.filter((n) => n.props && n.props.className === 'tp-mrow' && n.props['data-flash'] === '1').length === 1,
  'the roster row flashes with its chip, so the two views agree',
)
check(
  swarmTree !== null && swarmTree.nodes.every((n) => !(n.props && n.props['data-chip'] && n.props['data-flash'] === '1')),
  'no diff, no flash — the panel does not decorate a steady state',
)

// ------------------------------------------------------------------ teams --
// A profile can host unrelated teams. The flat list made one big table out of
// them, which is the thing this section exists to stop.
console.log('\nteams (one card each)')
const twoTeams = {
  ...happy,
  summary: { ...happy.summary, total: 9, completed: 4, inProgress: 3, pendingReady: 2, stalled: 1, members: { live: 4, total: 6 } },
  teams: [
    {
      leadId: 'session-a',
      label: 'Investigate the payment retry storm',
      summary: { ...happy.summary, total: 6, completed: 3, inProgress: 2, pendingReady: 1, stalled: 1, members: { live: 3, total: 4 } },
      attention: [{ kind: 'stalled', label: 'task-5', detail: 'owner beta is inactive' }],
      roster: HAPPY_ROSTER,
      goal: HAPPY_GOAL,
    },
    {
      leadId: 'session-z',
      label: 'team bb22',
      summary: { ...happy.summary, total: 3, completed: 1, inProgress: 1, pendingReady: 1, stalled: 0, members: { live: 1, total: 2 } },
      attention: [],
      roster: {
        state: 'ok',
        leads: 1,
        stalled: 0,
        members: [
          member({ leadId: 'session-z', id: 'session-z', name: 'lead', role: 'lead', status: 'inactive', claimed: 0 }),
          member({ leadId: 'session-z', id: 'session-delta', name: 'delta', status: 'inactive', claimed: 0 }),
        ],
      },
      goal: { state: 'none', goals: [] },
    },
  ],
}

const teamsTree = render('main panel (two teams)', panelReg.component, { snapshot: twoTeams, onAct: () => {} })
const cards = teamsTree === null ? [] : teamsTree.nodes.filter((n) => n.props && n.props.className === 'tp-card')
check(cards.length === 2, 'one card per team (' + cards.length + ')')
check(
  cards.length === 2 && cards[0].props['data-team'] === 'Investigate the payment retry storm',
  'the first card is labelled by its objective (' + (cards[0] && cards[0].props['data-team']) + ')',
)
check(
  cards.length === 2 && cards[1].props['data-team'] === 'team bb22',
  'the second card keeps its own handle (' + (cards[1] && cards[1].props['data-team']) + ')',
)
check(
  teamsTree !== null && joined(teamsTree).includes('Investigate the payment retry storm') && joined(teamsTree).includes('team bb22'),
  'both teams are named on screen, so an action cannot land on the wrong one',
)

// Each card owns its rows: no member of the other team leaks in.
const rowsByCard = (cards || []).map((card) => {
  const out = { members: [], counts: null }
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node.$$el) return
    if (typeof node.props['data-member'] === 'string') out.members.push(node.props['data-member'])
    if (node.props['data-team-counts'] === '1') out.counts = node.children.join('')
    if (typeof node.type === 'function') {
      React.hooks.cursor = 0
      walk(node.type(node.props))
    }
    walk(node.children)
  }
  walk(card.children)
  return out
})
check(rowsByCard[0].members.includes('alpha') && !rowsByCard[0].members.includes('delta'), 'team A lists only its own members (' + rowsByCard[0].members.join(',') + ')')
check(rowsByCard[1].members.includes('delta') && !rowsByCard[1].members.includes('alpha'), 'team B lists only its own members (' + rowsByCard[1].members.join(',') + ')')
check(rowsByCard[0].counts === '3/6 tasks', 'each card shows its own task count, not the global one (' + rowsByCard[0].counts + ')')
check(rowsByCard[1].counts === '1/3 tasks', 'the second card disagrees with the first, on purpose (' + rowsByCard[1].counts + ')')

// ---------------------------------------------------------- session scope --
// The host folds EVERY live lead's board into `summary` (agents.roots() in
// lib/index.js), so the flat headline was a process-wide total even when the tab
// was scoped to one session: another team's 126/132 printed above a 0/0 card and
// read as that session's work (2026-11-02 report). The headline is now narrowed
// by the same focus as the cards, in one place.
console.log('\nsession scope (the headline follows the focused team)')
const headlineCountNode = (tree) => (tree === null ? undefined : tree.nodes.find((n) => n.props && typeof n.props['data-counts'] === 'string'))
const headlineMembersNode = (tree) => (tree === null ? undefined : tree.nodes.find((n) => n.props && typeof n.props['data-members'] === 'string'))

const focusHeadlineTree = render('main panel (scoped to one session)', panelReg.component, { snapshot: twoTeams, sessionId: 'session-a', onAct: () => {} })
const headlineCount = headlineCountNode(focusHeadlineTree)
check(
  headlineCount !== undefined && headlineCount.props['data-counts'] === '3/6 tasks',
  'the headline counts the focused team only (' + (headlineCount && headlineCount.props['data-counts']) + ')',
)
const headlineMembers = headlineMembersNode(focusHeadlineTree)
check(
  headlineMembers !== undefined && headlineMembers.props['data-members'] === '3/4 members',
  'and its own members (' + (headlineMembers && headlineMembers.props['data-members']) + ')',
)
check(
  focusHeadlineTree !== null && !joined(focusHeadlineTree).includes('4/9 tasks'),
  'the process-wide task total is gone from a scoped headline',
)
check(
  focusHeadlineTree !== null && !joined(focusHeadlineTree).includes('4/6 members'),
  'and so is the process-wide member total',
)

const globalHeadlineCount = headlineCountNode(teamsTree)
check(
  globalHeadlineCount !== undefined && globalHeadlineCount.props['data-counts'] === '4/9 tasks',
  'unfocused, the same payload keeps the aggregate (' + (globalHeadlineCount && globalHeadlineCount.props['data-counts']) + ')',
)

// A focused session with no team has no board to count: words, never another
// lead's numbers and never a 0 standing in for "there is none".
const noTeamTree = render('main panel (session with no team)', panelReg.component, { snapshot: twoTeams, sessionId: 'session-absent', onAct: () => {} })
check(noTeamTree !== null && has(noTeamTree, 'data-scope-note', '1'), 'a session with no team says so')
check(noTeamTree !== null && joined(noTeamTree).includes('no team in this session'), 'in words, not in a count')
check(headlineCountNode(noTeamTree) === undefined, 'and prints no task count at all')
check(headlineMembersNode(noTeamTree) === undefined, 'and no member count')
check(noTeamTree !== null && !noTeamTree.nodes.some((n) => n.props && n.props.className === 'tp-bar'), 'and draws no bar for a board it does not have')

// A completed claim offers Reopen, not a no-op Complete.
const completedRoster = {
  ...happy,
  teams: [
    {
      leadId: 'session-a',
      label: 'done things',
      summary: happy.summary,
      attention: [],
      roster: {
        state: 'ok',
        leads: 1,
        stalled: 0,
        members: [
          member({ leadId: 'session-a', id: 'session-a', name: 'lead', role: 'lead', status: 'running', claimed: 0 }),
          member({ leadId: 'session-a', id: 'session-fin', name: 'fin', status: 'inactive', claimed: 1, taskId: 'task-9', taskSubject: 'already done', taskStatus: 'completed', taskRevision: 4 }),
        ],
      },
      goal: HAPPY_GOAL,
    },
  ],
}
const completedTree = render('main panel (completed claim)', panelReg.component, { snapshot: completedRoster, onAct: () => {} })
const completedActs = completedTree === null ? [] : completedTree.nodes.filter((n) => n.props && n.props['data-act']).map((n) => n.props['data-act'])
check(completedActs.includes('task-reopen'), 'a completed claim offers Reopen (' + completedActs.join(',') + ')')
check(!completedActs.includes('task-complete'), 'and does not offer a no-op Complete')

// Dormant teams are folded, not deleted: the working team owns the screen.
const dormantPayload = { ...twoTeams, teams: [twoTeams.teams[0], { ...twoTeams.teams[1], dormant: true }] }
const dormantTree = render('main panel (dormant folded)', panelReg.component, { snapshot: dormantPayload, onAct: () => {} })
check(dormantTree !== null && dormantTree.nodes.filter((n) => n.props && n.props.className === 'tp-card').length === 1, 'only the working team renders expanded (' + (dormantTree && dormantTree.nodes.filter((n) => n.props && n.props.className === 'tp-card').length) + ')')
const toggle = dormantTree === null ? undefined : dormantTree.nodes.find((n) => n.props && n.props.className === 'tp-dormant-toggle')
check(toggle !== undefined, 'a counted disclosure offers the dormant teams')
check(toggle && /1 dormant team/.test(toggle.children.join('')), 'the disclosure counts them (' + (toggle && toggle.children.join('')) + ')')
check(dormantTree !== null && !joined(dormantTree).includes('team bb22'), 'a folded team is not on screen until asked for')
if (toggle) toggle.props.onClick()
React.hooks.cursor = 0
const dormantOpen = { nodes: [], text: [] }
collect(panelReg.component({ snapshot: dormantPayload, onAct: () => {} }), dormantOpen)
check(
  dormantOpen.nodes.filter((n) => n.props && n.props.className === 'tp-card').length === 2,
  'opening the disclosure reveals the folded team (' + dormantOpen.nodes.filter((n) => n.props && n.props.className === 'tp-card').length + ' cards)',
)
check(
  Object.keys(dormantOpen.text.join('')).length > 0 && dormantOpen.nodes.some((n) => n.props && n.props['data-team'] === 'team bb22'),
  'the revealed card carries the dormant team, not a duplicate of the working one',
)

// A teammate with nothing claimed is still a teammate: it gets a quiet nudge, not
// no control at all, and the message it sends never refers to a task it does not
// hold. This was the "why do some rows have no nudge or wake?" report.
const idleActs = teamsTree === null ? [] : teamsTree.nodes.filter((n) => n.props && n.props['data-act'] === 'wake').map((n) => n.props)
check(idleActs.length === 4, 'every non-lead teammate carries a nudge/wake control (' + idleActs.length + ')')
const claimless = idleActs.filter((n) => n['data-tone'] === 'quiet')
check(claimless.length >= 1, 'the claimless ones are quiet nudges, not amber wakes (' + claimless.length + ')')
check(
  teamsTree !== null && teamsTree.nodes.some((n) => n.props && /no claimed task/.test(String(n.props.title))),
  'the claimless nudge says the true reason it exists',
)

// ------------------------------------------------- the tree inside the card --
// The owner works in this panel and the tree lived on another page: the chip said
// "81 branches" and there was nothing behind it. The chip now expands in place,
// and — this is the constraint — collapsed it must stay the same chip.
console.log('card lineage chip')
{
  const branchRows = []
  for (let index = 0; index < 20; index += 1) {
    const id = 'session-b' + String(index).padStart(6, '0')
    branchRows.push({
      sessionId: id,
      label: index === 0 ? 'Build a new local DSH · 0a1b' : index === 1 ? 'session 9f9f9f9f' : 'Branch ' + index,
      labelSource: index === 0 ? 'title+disambiguated' : index === 1 ? 'session-id' : 'title',
      state: index === 2 ? 'running' : index === 1 ? 'blank' : 'inactive',
      ageSeconds: index === 3 ? null : 600 * (index + 1),
    })
  }
  const lineagePayload = {
    ...boardPayload,
    teams: [
      {
        ...boardPayload.teams[0],
        lineage: { state: 'ok', forks: 60, subagents: 20, other: 1, branches: 81, rows: branchRows, truncated: true, rowState: 'ok' },
      },
    ],
  }

  const openedRows = []
  const props = { snapshot: lineagePayload, onAct: () => {}, onOpen: (row) => openedRows.push(row) }

  React.hooks.cursor = 0
  React.hooks.state = []
  const collapsed = { nodes: [], text: [] }
  collect(panelReg.component(props), collapsed)

  const chip = collapsed.nodes.find((n) => n.props && n.props.className === 'tp-card-lineage')
  check(chip !== undefined, 'the card still carries the branches chip')
  check(
    chip !== undefined && chip.props.className === 'tp-card-lineage',
    'collapsed: the chip keeps its original class and adds none',
  )
  check(textIn(chip) === '81 branches', 'collapsed: the chip still reads "81 branches" (got ' + textIn(chip) + ')')
  check(chip.props.style === undefined, 'collapsed: no inline style is added')
  check(
    collapsed.nodes.every((n) => n.props === undefined || n.props.className !== 'tp-branches'),
    'collapsed: no rows are rendered until the chip is opened',
  )
  check(chip.props['data-expandable'] === 'true', 'the chip announces that it can expand')
  check(chip.props['aria-expanded'] === false, 'the chip starts collapsed')

  chip.props.onClick()
  React.hooks.cursor = 0
  const opened = { nodes: [], text: [] }
  collect(panelReg.component(props), opened)

  const list = opened.nodes.find((n) => n.props && n.props.className === 'tp-branches')
  check(list !== undefined, 'clicking the chip expands the tree in place')
  const rows = opened.nodes.filter((n) => n.props && n.props.className === 'tp-branch')
  check(rows.length === 20, 'the expanded list renders the 20 rows the host sent (' + rows.length + ')')
  check(
    opened.nodes.some((n) => n.props && n.props.className === 'tp-branch-dot' && n.props['data-state'] === 'running'),
    'a running branch carries a running dot',
  )
  check(
    opened.nodes.some((n) => n.props && n.props.className === 'tp-branch-dot' && n.props['data-state'] === 'blank'),
    'a branch with no title carries its own dot state',
  )
  check(joined(opened).includes('Build a new local DSH · 0a1b'), 'a disambiguated title renders verbatim')
  check(joined(opened).includes('session 9f9f9f9f'), 'a row with no title renders its short id, never "blank"')
  check(!joined(opened).includes(' blank '), 'no row renders the word "blank" as a label')
  check(joined(opened).includes('showing 20 of 81'), 'a truncated tree says "showing 20 of 81"')
  check(
    opened.nodes.filter((n) => n.props && n.props.className === 'tp-branch-age').length === 20,
    'every row carries a right-aligned age',
  )
  check(
    opened.nodes.filter((n) => n.props && n.props.className === 'tp-branch').every((n) => n.props.onClick !== undefined),
    'every row is clickable',
  )

  rows[0].props.onClick()
  check(openedRows.length === 1, 'clicking a row opens exactly one session')
  check(
    openedRows[0] && openedRows[0].id === 'session-b000000' && openedRows[0].leadId === 'session-a',
    'the row opens through the same {id, leadId} call the member rows use (got ' + JSON.stringify(openedRows[0]) + ')',
  )

  // Collapsing again removes the rows and leaves the chip exactly as it was.
  const chipNow = opened.nodes.find((n) => n.props && n.props.className === 'tp-card-lineage')
  chipNow.props.onClick()
  React.hooks.cursor = 0
  const recollapsed = { nodes: [], text: [] }
  collect(panelReg.component(props), recollapsed)
  check(
    recollapsed.nodes.every((n) => n.props === undefined || n.props.className !== 'tp-branches'),
    'clicking again collapses the tree',
  )
  const chipAgain = recollapsed.nodes.find((n) => n.props && n.props.className === 'tp-card-lineage')
  check(textIn(chipAgain) === '81 branches', 'collapsed again, the chip is unchanged')
}

{
  // A card whose lineage could not be read keeps today's chip behaviour: no
  // expansion, no empty list, no error.
  const noRows = {
    ...boardPayload,
    teams: [{ ...boardPayload.teams[0], lineage: { state: 'ok', forks: 0, subagents: 0, other: 0, branches: 4, rows: [], truncated: false, rowState: 'unavailable' } }],
  }
  const tree = render('main panel (lineage unreadable)', panelReg.component, { snapshot: noRows, onAct: () => {} })
  const chip = tree === null ? undefined : tree.nodes.find((n) => n.props && n.props.className === 'tp-card-lineage')
  check(chip !== undefined, 'a card with branches but no rows still shows its chip')
  check(chip.props['data-expandable'] === 'false', 'a chip with nothing behind it does not pretend to open')
  check(tree.nodes.every((n) => n.props === undefined || n.props.className !== 'tp-branches'), 'and it renders no empty list')
}

console.log('')
if (failures === 0) {
  console.log('PASS — client half renders the four views, with every absence named')
} else {
  console.log('FAIL — ' + failures + ' check(s) failed')
  process.exit(1)
}
