// Clicking a teammate must open its session even when `uiWorkspace` was not yet
// registered when the panel mounted. Run: node test/open-session.mjs

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

function makeReact() {
  const hooks = { state: [], cursor: 0 }
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
    useEffect() { hooks.cursor += 1 },
    useRef(v) { hooks.cursor += 1; return { current: v === undefined ? null : v } },
    useMemo(fn) { hooks.cursor += 1; return fn() },
    useCallback(fn) { hooks.cursor += 1; return fn },
  }
}

const g = globalThis
g.window = g.window || {}
let registered = null
g.window.__ModuleLoader__ = { load(def) { registered = def } }
g.fetch = () => Promise.reject(new Error('network disabled'))
const errors = []
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    head: { children: [], appendChild(n) { this.children.push(n) } },
    body: { appendChild(n) { errors.push(String(n.textContent || '')) } },
    createElement() {
      return { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v }, remove() {} }
    },
  }
}

const React = makeReact()
eval(clientSrc) // eslint-disable-line no-eval -- this is the test
const mod = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

// The app registers `uiWorkspace` from another client plugin. Model the race:
// the service is absent at mount and appears afterwards.
const opened = []
let exposeWorkspace = false
const slots = []
const ctx = {
  get: (key) => {
    if (key === 'slots') {
      return {
        inject(name, factory) { slots.push(name); const d = factory(); return typeof d === 'function' ? d : () => {} },
        register(descriptor, component) { slots.push({ descriptor, component }); return () => {} },
      }
    }
    if (key === 'uiWorkspace') {
      return exposeWorkspace
        ? { openSession: (target) => opened.push(target) }
        : undefined
    }
    return undefined
  },
  inject(services, callback) { callback(ctx); return () => {} },
  effect: (fn) => fn(),
}
mod.apply(ctx)

const panel = slots.find((s) => s.descriptor && s.descriptor.name === 'conversation.view')
check(panel !== undefined, 'registers the conversation tab')

function elementsOf(node, out) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { node.forEach((c) => elementsOf(c, out)); return out }
  if (typeof node !== 'string' && typeof node !== 'number' && node.$$el) {
    out.push(node)
    if (typeof node.type === 'function') { React.hooks.cursor = 0; elementsOf(node.type(node.props), out) }
    elementsOf(node.children, out)
  }
  return out
}

const roster = {
  state: 'ok',
  leads: 1,
  stalled: 0,
  members: [
    { id: 'session-lead', leadId: 'session-lead', name: 'lead', role: 'lead', status: 'running', stalled: false, claimed: 0, taskId: null, taskRevision: null, taskSubject: null, taskStatus: null },
    { id: 'session-child', leadId: 'session-lead', name: 'agent-13', role: 'teammate', status: 'running', stalled: false, claimed: 0, taskId: null, taskRevision: null, taskSubject: null, taskStatus: null },
  ],
}
const snapshot = {
  ok: true,
  generatedAt: new Date().toISOString(),
  summary: { total: 0, completed: 0, inProgress: 0, pendingReady: 0, blocked: 0, stalled: 0, members: { live: 2, total: 2 } },
  roster,
  defects: { state: 'unavailable', reason: 'none', files: [], counts: null, open: [] },
  goal: { state: 'none', goals: [] },
  attention: [],
  actions: { enabled: true, policy: 'all' },
  waitingOnYou: { state: 'ok', total: 0, stalled: 0, unassigned: 0, idle: null },
  degraded: { any: false, reasons: [] },
}

React.hooks.cursor = 0
React.hooks.state = []
const nodes = elementsOf(panel.component({ snapshot }), [])
const link = nodes.find((n) => n.props && n.props.className === 'tp-mname tp-link' && typeof n.props.onClick === 'function')
check(link !== undefined, 'the teammate name is a clickable control')

// The service appears only now — after mount.
exposeWorkspace = true
errors.length = 0
if (link) link.props.onClick({ stopPropagation() {} })

check(errors.length === 0, 'no failure popup once the service is live (' + JSON.stringify(errors) + ')')
check(opened.length === 1, 'the click opened exactly one session (got ' + opened.length + ')')
check(
  opened[0] && opened[0].parentSessionId === 'session-lead' && opened[0].childSessionId === 'session-child',
  'it opened that teammate under its own lead (' + JSON.stringify(opened[0]) + ')',
)

console.log(failures === 0 ? '\nPASS: clicking a teammate opens its session' : '\n' + String(failures) + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
