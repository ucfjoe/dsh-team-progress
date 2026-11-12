import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { setModelState } from '../lib/model-selection.js'

const catalog = {
  default: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
  routableProviders: ['hf-litellm'],
  groups: [{
    id: 'hf-litellm',
    name: 'Router',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
      { id: 'gpt-6.1-sol', name: 'Sol' }
    ]
  }]
}

const selection = { provider: 'hf-litellm', model: 'gpt-6.1-sol' }
const recorded = []
const lead = { id: 'session-lead', session: { id: 'session-lead', header: { id: 'session-lead', createdAt: 1 }, snapshotEvents: () => [], requestHeader: () => undefined } }
const teammate = {
  id: 'session-coder',
  session: { id: 'session-coder', header: { id: 'session-coder', createdAt: 2 }, snapshotEvents: () => [], requestHeader: () => undefined },
  model: { select: value => recorded.push(value) }
}
const descendants = [{
  kind: 'child', id: 'session-coder', parentId: 'session-lead', depth: 1,
  path: 'coder', label: 'writes code', mode: 'continuable', activity: 'running', hasChildren: false
}]

function deps(overrides = {}) {
  const logs = []
  const defaults = {
    current: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
    currentSelection() { return this.current },
    saveSelection: async () => {}
  }
  return {
    logs,
    value: {
      sessionController: () => ({ modelCatalog: async () => catalog, selectModel: async request => ({ selected: { ...request } }) }),
      agents: () => ({ list: () => [lead, teammate], get: id => id === 'session-lead' ? lead : id === 'session-coder' ? teammate : undefined }),
      subagents: () => ({ rootOf: () => lead, listDescendants: async () => descendants }),
      sessionQuery: () => ({ readSession: async () => { throw new Error('missing') } }),
      agentDefaultModel: () => overrides.defaults === null ? undefined : (overrides.defaults || defaults),
      llm: () => ({ resolveCallConfig: async v => v }),
      logger: () => ({ warn: line => logs.push(line) }),
    }
  }
}

// 1. A selection is reported as what the session RECORDED, not the request.
{
  recorded.length = 0
  const { value } = deps()
  const result = await setModelState(value, line => {}, { target: 'coder', ...selection, caller: lead })
  assert.deepEqual(recorded, [selection])
  assert.deepEqual(result.selection, selection, 'the recorded selection is reported')
}

// 2. A failing default restore must not turn an applied change into a failure.
{
  const { value, logs } = deps({
    defaults: {
      current: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
      currentSelection() { return this.current },
      saveSelection: async () => { throw new Error('profile write is read-only') }
    }
  })
  const result = await setModelState(value, line => logs.push(line), { target: 'session-lead', ...selection, caller: lead })
  assert.deepEqual(result.selection, selection, 'the applied selection is still reported')
  assert.ok(logs.some(line => /restore|default/i.test(line)), 'the failed restore is reported, not swallowed: ' + JSON.stringify(logs))
}

// 3. A half-specified selection is refused, not silently ignored.
{
  const { value } = deps()
  await assert.rejects(
    setModelState(value, () => {}, { target: 'coder', provider: 'hf-litellm', caller: lead }),
    /provider and model/i
  )
}

// 4. model-set obeys the profile's mutation opt-in.
{
  let route
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: spec => { route = spec; return () => {} } }
      if (name === 'agents') return { list: () => [lead, teammate], get: id => id === 'session-lead' ? lead : teammate }
      if (name === 'subagents') return { rootOf: () => lead, listDescendants: async () => descendants }
      if (name === 'agentTeams') return { listTasks: () => [] }
      if (name === 'sessionController') return { modelCatalog: async () => catalog }
      if (name === 'llm') return { resolveCallConfig: async v => v }
      if (name === 'sessionProjections') return { stateOf: () => undefined }
      if (name === 'sessionQuery') return { filterSessions: async () => [] }
      return undefined
    },
    effect: fn => fn(),
    logger: { info() {}, warn() {}, error() {} }
  }
  apply(ctx, { allowMutations: false })
  async function call(method, args) {
    let payload
    const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method, args })) } }
    const res = { writeHead() {}, end(text) { payload = JSON.parse(text) } }
    await route.handler(req, res)
    return payload
  }
  await call('models')
  recorded.length = 0
  const refused = await call('model-set', { sessionId: 'session-coder', ...selection })
  assert.equal(refused.ok, false, 'model-set is refused while mutations are disabled')
  assert.equal(recorded.length, 0, 'nothing was changed on a refused call')
}

console.log('PASS: model selection reports what it recorded and obeys the mutation gate')
