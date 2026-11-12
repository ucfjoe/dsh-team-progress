// Model controls in the Team Progress panel.
//
// Renders the real client bundle with a fixture snapshot and a fixture model
// state, then asserts the controls exist, show the model actually in force, and
// send the selection the reader chose. Run: node test/model-controls-client.mjs

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
g.fetch = () => Promise.reject(new Error('network disabled during verification'))
if (typeof globalThis.document === 'undefined') {
  const head = { children: [], appendChild(node) { this.children.push(node) } }
  const body = { children: [], appendChild(node) { this.body_ = node } }
  globalThis.document = {
    head,
    body,
    createElement(tag) {
      return { tag, attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v }, remove() {} }
    },
  }
}

const React = makeReact()
eval(clientSrc) // eslint-disable-line no-eval -- this is the test
const mod = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

const slots = []
const ctx = {
  get: (key) => key === 'slots'
    ? {
      inject(name, factory) { slots.push({ name }); const d = factory(); return typeof d === 'function' ? d : () => {} },
      register(descriptor, component) { slots.push({ descriptor, component }); return () => {} },
    }
    : undefined,
  inject(services, callback) { callback(ctx); return () => {} },
  effect: (fn) => fn(),
}
mod.apply(ctx)
const panelReg = slots.find((s) => s.descriptor && s.descriptor.name === 'conversation.view')

function elementsOf(node, out) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { node.forEach((c) => elementsOf(c, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') return out
  if (!node.$$el) return out
  out.push(node)
  if (typeof node.type === 'function') { React.hooks.cursor = 0; elementsOf(node.type(node.props), out) }
  elementsOf(node.children, out)
  return out
}

function render(props) {
  React.hooks.cursor = 0
  React.hooks.state = []
  return elementsOf(panelReg.component(props), [])
}

const snapshot = {
  ok: true,
  generatedAt: new Date().toISOString(),
  summary: { total: 1, completed: 0, inProgress: 1, pendingReady: 0, blocked: 0, stalled: 0, members: { live: 2, total: 2 } },
  roster: {
    state: 'ok',
    leads: 1,
    stalled: 0,
    members: [
      { id: 'session-lead', leadId: 'session-lead', name: 'lead', role: 'lead', status: 'running', stalled: false, claimed: 0, taskId: null, taskRevision: null, taskSubject: null, taskStatus: null },
      { id: 'session-coder', leadId: 'session-lead', name: 'coder', role: 'teammate', status: 'inactive', stalled: false, claimed: 0, taskId: null, taskRevision: null, taskSubject: null, taskStatus: null },
    ],
  },
  defects: { state: 'unavailable', reason: 'none', files: [], counts: null, open: [] },
  goal: { state: 'none', goals: [] },
  attention: [],
  actions: { enabled: true, policy: 'all' },
  waitingOnYou: { state: 'ok', total: 0, stalled: 0, unassigned: 0, idle: null },
  degraded: { any: false, reasons: [] },
  limits: { members: 8 },
}

const models = {
  ok: true,
  state: {
    agents: [
      { target: 'lead', sessionId: 'session-lead', kind: 'lead', live: true, settable: true, selected: null, inEffect: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash', reasoningEffort: 'max' } },
      { target: 'coder', sessionId: 'session-coder', kind: 'teammate', live: true, settable: true, selected: { provider: 'hf-litellm', model: 'gpt-6.1-sol' }, inEffect: { provider: 'hf-litellm', model: 'gpt-6.1-sol' } },
    ],
    routableProviders: ['hf-litellm'],
    defaultSelection: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash', reasoningEffort: 'max' },
  },
  picker: {
    ok: true,
    defaultSelection: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash', reasoningEffort: 'max' },
    groups: [{
      id: 'hf-litellm',
      name: 'Router',
      models: [
        { id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'Flash', efforts: [{ id: 'max', name: 'Max' }] },
        { id: 'gpt-6.1-sol', name: 'Sol', efforts: [] },
      ],
    }],
    failures: [],
  },
}

console.log('model controls')

const acts = []
const nodes = render({ snapshot, models, onAct: (payload) => acts.push(payload) })

const modelCells = nodes.filter((n) => n.props && typeof n.props['data-model-for'] === 'string')
check(modelCells.length === 2, 'every member row carries a model cell (got ' + modelCells.length + ')')

const coderCell = nodes.find((n) => n.props && n.props['data-model-for'] === 'session-coder')
check(coderCell !== undefined, 'the teammate row is addressed by session id')
check(
  coderCell && coderCell.children.some((c) => typeof c === 'string' && c.includes('Sol')),
  'the cell names the model actually in force (' + JSON.stringify(coderCell && coderCell.children) + ')',
)

const leadCell = nodes.find((n) => n.props && n.props['data-model-for'] === 'session-lead')
check(
  leadCell && leadCell.children.some((c) => typeof c === 'string' && c.includes('Flash') && c.includes('max')),
  'a model with an effort shows both (' + JSON.stringify(leadCell && leadCell.children) + ')',
)

const picker = nodes.find((n) => n.props && n.props['data-model-picker'] === 'session-coder')
check(picker !== undefined, 'each settable member offers a model picker')
check(
  picker && picker.children.some((child) => child && child.props && child.props['data-model-option'] !== undefined),
  'the picker offers routable models',
)

// Changing a selection sends the exact triple for that member.
acts.length = 0
if (picker && typeof picker.props.onChange === 'function') {
  picker.props.onChange({ target: { value: 'hf-litellm\u0000deepseek-ai/DeepSeek-V4.1-Flash\u0000max' }, stopPropagation() {} })
}
check(acts.length === 1, 'changing the picker dispatches one action (got ' + acts.length + ')')
check(
  acts[0] && acts[0].action === 'model-set' && acts[0].sessionId === 'session-coder',
  'the action targets that member (' + JSON.stringify(acts[0]) + ')',
)
check(
  acts[0] && acts[0].provider === 'hf-litellm' && acts[0].model === 'deepseek-ai/DeepSeek-V4.1-Flash' && acts[0].reasoningEffort === 'max',
  'the action carries provider, model and effort (' + JSON.stringify(acts[0]) + ')',
)

// Spawn carries the same kind of selection.
const spawnNodes = render({ snapshot: { ...snapshot, roster: { ...snapshot.roster, members: snapshot.roster.members } }, models, onAct: (payload) => acts.push(payload) })
const spawnToggle = spawnNodes.find((n) => n.props && n.props['data-spawn-toggle'] === '1')
check(spawnToggle !== undefined, 'the members section still offers a new-agent control')

console.log(failures === 0 ? '\nPASS: the panel shows and changes per-agent models' : '\n' + String(failures) + ' check(s) failed')
process.exit(failures === 0 ? 0 : 1)
