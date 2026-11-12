import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const selection = { provider: 'hf-litellm', model: 'gpt-6.1-sol' }
const catalog = {
  default: selection,
  routableProviders: ['hf-litellm'],
  groups: [{ id: 'hf-litellm', name: 'Router', models: [{ id: 'gpt-6.1-sol', name: 'Sol' }] }]
}
const session = { id: 'session-coder', header: { id: 'session-coder', createdAt: 1 }, snapshotEvents: () => [], requestHeader: () => ({ config: selection }) }
const selections = []
const coder = { id: 'session-coder', session, model: { select: value => selections.push(value) } }
const lead = { id: 'session-lead', session: { id: 'session-lead', header: { id: 'session-lead', createdAt: 1 }, snapshotEvents: () => [], requestHeader: () => undefined } }
const descendants = [{
  kind: 'child', id: 'session-coder', parentId: 'session-lead', depth: 1,
  path: 'coder', label: 'writes code', mode: 'continuable', activity: 'inactive', hasChildren: false
}]
const subagents = {
  rootOf: () => lead,
  listDescendants: async () => descendants
}
let route
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: spec => { route = spec } }
    if (name === 'agents') return { list: () => [lead, coder], get: id => id === 'session-coder' ? coder : lead }
    if (name === 'subagents') return subagents
    if (name === 'agentTeams') return { listTasks: () => [] }
    if (name === 'sessionController') return { modelCatalog: async () => catalog }
    if (name === 'llm') return { resolveCallConfig: async value => value }
    if (name === 'sessionProjections') return { stateOf: () => undefined }
    if (name === 'sessionQuery') return { filterSessions: async () => [] }
    if (name === 'goals') return { get: () => undefined }
    return undefined
  },
  effect: fn => fn(),
  logger: { info() {}, warn() {}, error() {} }
}
apply(ctx, { allowMutations: true })

async function call(method, args) {
  let payload
  const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method, args })) } }
  const res = { writeHead() {}, end(text) { payload = JSON.parse(text) } }
  await route.handler(req, res)
  return payload
}

const listed = await call('models')
assert.equal(listed.ok, true)
assert.equal(listed.picker.ok, true)
assert.equal(listed.state.agents.find(row => row.sessionId === 'session-coder').target, 'coder')

const changed = await call('model-set', { sessionId: 'session-coder', ...selection })
assert.equal(changed.ok, true)
assert.deepEqual(selections, [selection])
assert.deepEqual(changed.selection, selection)
console.log('PASS: Team Progress serves model state and live model selection')
