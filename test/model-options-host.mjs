import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const selection = { provider: 'hf-litellm', model: 'gpt-6.1-sol' }
const catalog = {
  default: { provider: 'hf-litellm', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
  routableProviders: ['hf-litellm'],
  groups: [{ id: 'hf-litellm', name: 'Router', models: [{ id: 'gpt-6.1-sol', name: 'Sol' }] }]
}

const lead = {
  id: 'session-lead',
  session: { id: 'session-lead', header: { id: 'session-lead', createdAt: 1 }, snapshotEvents: () => [], requestHeader: () => undefined }
}
const idleSelects = []
const idle = {
  id: 'session-idle',
  session: { id: 'session-idle', header: { id: 'session-idle', createdAt: 2 }, snapshotEvents: () => [], requestHeader: () => undefined },
  model: { select: value => idleSelects.push(value) }
}
const descendants = [{
  kind: 'child', id: 'session-idle', parentId: 'session-lead', depth: 1,
  path: 'idle-dev', label: 'idle teammate', mode: 'continuable', activity: 'inactive', hasChildren: false
}]

const spawns = []
const updates = []
const tasks = [{ id: 'task-1', revision: 1, subject: 'do work', description: 'd', status: 'pending', blockedBy: [], writeScopes: [], ready: true }]
let failSelection = false
let route

const ctx = {
  get(name) {
    if (name === 'webServer') return { register: spec => { route = spec; return () => {} } }
    if (name === 'agents') {
      return {
        list: () => [lead, idle],
        get: id => id === 'session-lead' ? lead : id === 'session-idle' ? idle : undefined
      }
    }
    if (name === 'subagents') {
      return {
        rootOf: () => lead,
        listDescendants: async () => descendants,
        resolveName: async (_caller, name) => name === 'idle-dev' ? 'session-idle' : name,
        startActivation: async spec => { spawns.push(spec); return { childId: 'session-new', name: spec.name } },
        namesOf: () => ({ self: 'lead' }),
        sendMessage: async () => 'message-1'
      }
    }
    if (name === 'agentTeams') {
      return {
        listTasks: () => tasks,
        updateTask: (_caller, request) => {
          updates.push(request)
          return { ...tasks[0], revision: request.expectedRevision + 1, status: 'in_progress', ownerId: request.owner }
        }
      }
    }
    if (name === 'sessionController') return { modelCatalog: async () => catalog }
    if (name === 'llm') {
      return {
        resolveCallConfig: async value => {
          if (failSelection) throw new Error('route rejected')
          return value
        }
      }
    }
    if (name === 'sessionProjections') return { stateOf: () => undefined }
    if (name === 'sessionQuery') return { filterSessions: async () => [], readSession: async () => { throw new Error('missing') } }
    return undefined
  },
  effect: fn => fn(),
  logger: { info() {}, warn() {}, error() {} }
}

apply(ctx, { allowMutations: true })

async function act(args) {
  let payload
  const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method: 'act', args })) } }
  const res = { writeHead() {}, end(text) { payload = JSON.parse(text) } }
  await route.handler(req, res)
  return payload
}

const spawned = await act({ action: 'spawn', leadId: 'session-lead', name: 'modeled', prompt: 'work', provider: 'hf-litellm', model: 'gpt-6.1-sol' })
assert.equal(spawned.ok, true, JSON.stringify(spawned))
assert.deepEqual(spawns.at(-1).agentOptions, selection, 'spawn passes agentOptions')

await act({
  action: 'task',
  op: 'reassign',
  leadId: 'session-lead',
  taskId: 'task-1',
  expectedRevision: 1,
  owner: 'idle-dev',
  notify: false,
  provider: 'hf-litellm',
  model: 'gpt-6.1-sol'
})
assert.deepEqual(idleSelects, [selection], 'an existing teammate switches before reassignment')
assert.equal(updates.at(-1).owner, 'session-idle', 'the assignment targets the switched teammate')

failSelection = true
idleSelects.length = 0
updates.length = 0
await act({
  action: 'task',
  op: 'reassign',
  leadId: 'session-lead',
  taskId: 'task-1',
  expectedRevision: 1,
  owner: 'idle-dev',
  notify: false,
  provider: 'hf-litellm',
  model: 'gpt-6.1-sol'
})
assert.equal(idleSelects.length, 0)
assert.equal(updates.length, 0, 'a failed selection blocks the assignment')

failSelection = false
spawns.length = 0
idleSelects.length = 0
updates.length = 0
// A board with no idle teammate forces the spawn branch, so the check below
// cannot pass on an empty list: exactly one activation must carry the options.
tasks.length = 0
tasks.push({ id: 'task-2', revision: 1, subject: 'unowned work', description: 'd', status: 'pending', blockedBy: [], writeScopes: [], ready: true })
descendants.length = 0
await act({ action: 'auto-assign', leadId: 'session-lead', spawn: true, maxSpawns: 1, provider: 'hf-litellm', model: 'gpt-6.1-sol' })
assert.equal(spawns.length, 1, 'auto-assign created exactly one agent (got ' + spawns.length + ')')
assert.deepEqual(spawns[0].agentOptions, selection, 'the spawned agent carries the chosen model')

console.log('PASS: Spawn and assignment apply the chosen model')
