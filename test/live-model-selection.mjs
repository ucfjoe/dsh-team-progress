import assert from 'node:assert/strict'
import { setModelState } from '../lib/model-selection.js'

const selection = { provider: 'hf-litellm', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
const catalog = {
  default: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
  routableProviders: ['hf-litellm'],
  groups: [{
    id: 'hf-litellm',
    name: 'Router',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'Flash' },
      { id: 'gpt-6.1-sol', name: 'Sol', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }
    ]
  }]
}
const lead = { id: 'session-lead' }
const descendants = [{
  kind: 'child', id: 'session-coder', parentId: 'session-lead', depth: 1,
  path: 'coder', label: 'writes code', mode: 'continuable', activity: 'inactive', hasChildren: false
}]

function harness({ cold = false, invalid = false } = {}) {
  const calls = { select: [], controller: [], messages: [], resolved: [], saves: [] }
  const teammate = {
    model: {
      select: value => calls.select.push(value)
    }
  }
  const agents = {
    list: () => [lead],
    get: id => {
      if (id === 'session-lead') return lead
      if (id === 'session-coder' && !cold) return teammate
      if (id === 'session-fresh') return { id: 'session-fresh' }
      return undefined
    }
  }
  const subagents = {
    rootOf: () => lead,
    listDescendants: async () => descendants,
    sendMessage: async (...args) => {
      calls.messages.push(args)
      cold = false
      return 'message-1'
    }
  }
  const defaultModel = {
    current: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
    currentSelection() { return this.current },
    saveSelection: async value => { calls.saves.push(value); defaultModel.current = value }
  }
  const deps = {
    agents: () => agents,
    subagents: () => subagents,
    agentDefaultModel: () => defaultModel,
    sessionController: () => ({
      modelCatalog: async () => catalog,
      selectModel: async request => {
        calls.controller.push(request)
        defaultModel.current = request
        return { selected: { ...request } }
      }
    }),
    sessionQuery: () => ({ readSession: async id => { throw new Error(`session "${id}" not found`) } }),
    llm: () => ({
      resolveCallConfig: async value => {
        calls.resolved.push(value)
        if (invalid) throw new Error('route rejected')
        return value
      }
    })
  }
  return { deps, calls }
}

{
  const { deps, calls } = harness()
  const value = await setModelState(deps, () => {}, {
    target: 'coder', ...selection, caller: lead
  })
  assert.deepEqual(calls.select, [selection])
  assert.equal(calls.controller.length, 0)
  assert.equal(calls.messages.length, 0)
  assert.equal(calls.saves.length, 0)
  assert.deepEqual(calls.resolved, [selection])
  assert.equal(value.resumed, undefined)
  assert.deepEqual(value.selection, selection)
}

{
  const { deps, calls } = harness({ cold: true })
  const value = await setModelState(deps, () => {}, {
    target: 'coder', ...selection, caller: lead
  })
  assert.equal(calls.messages.length, 1)
  assert.equal(calls.messages[0][0], lead)
  assert.equal(calls.messages[0][1], 'session-coder')
  assert.deepEqual(calls.select, [selection])
  assert.equal(calls.controller.length, 0)
  assert.equal(value.resumed, true)
}

{
  const { deps, calls } = harness({ cold: true, invalid: true })
  await assert.rejects(
    setModelState(deps, () => {}, { target: 'coder', ...selection, caller: lead }),
    /route rejected/
  )
  assert.equal(calls.messages.length, 0)
  assert.equal(calls.select.length, 0)
}

{
  const { deps, calls } = harness()
  const value = await setModelState(deps, () => {}, {
    target: 'session-fresh', ...selection, caller: lead
  })
  assert.equal(calls.controller.length, 1)
  assert.deepEqual(calls.saves.at(-1), { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash' })
  assert.deepEqual(value.selection, selection)
}

console.log('PASS: live and cold teammates switch models without changing root defaults')
