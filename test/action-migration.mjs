import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const session = { id: 'session-lead', header: { id: 'session-lead', createdAt: 1 }, seq: 1 }
const lead = { id: 'session-lead', status: 'running', session }
const calls = { messages: [], spawns: [], names: [] }
const subagents = {
  rootOf: () => lead,
  listDescendants: async () => [],
  resolveName: async (_caller, name) => {
    calls.names.push(name)
    return name === 'native-verify' ? 'session-native' : name
  },
  sendMessage: async (...args) => {
    calls.messages.push(args)
    return 'message-1'
  },
  startActivation: async spec => {
    calls.spawns.push(spec)
    return { childId: 'session-new', name: spec.name, result: Promise.resolve({ output: [], stopReason: 'completed' }) }
  }
}
let route
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: spec => { route = spec } }
    if (name === 'agents') return { list: () => [lead], get: () => lead }
    if (name === 'subagents') return subagents
    if (name === 'agentTeams') return { listTasks: () => [] }
    return undefined
  },
  effect: fn => fn(),
  logger: { info() {}, warn() {}, error() {} }
}
apply(ctx, { allowMutations: true })

async function act(args) {
  let status
  let payload
  const req = {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ method: 'act', args }))
    }
  }
  const res = {
    writeHead(code) { status = code },
    end(text) { payload = JSON.parse(text) }
  }
  await route.handler(req, res)
  assert.equal(status, 200, JSON.stringify(payload))
  return payload
}

await act({ action: 'wake', leadId: 'session-lead', target: 'native-verify', message: 'Status?' })
assert.equal(calls.names[0], 'native-verify')
assert.equal(calls.messages.length, 1)
const [sender, targetId, content, options] = calls.messages[0]
assert.equal(sender, lead)
assert.equal(targetId, 'session-native')
assert.deepEqual(content, [{ type: 'text', text: 'Status?' }])
assert.ok(options.signal instanceof AbortSignal)

await act({ action: 'spawn', leadId: 'session-lead', name: 'new-agent', prompt: 'Do the work.' })
assert.equal(calls.spawns.length, 1)
assert.equal(calls.spawns[0].provider, 'spawn')
assert.equal(calls.spawns[0].parent, lead)
assert.equal(calls.spawns[0].delivery, 'parent')
assert.equal(calls.spawns[0].label, 'created from the team board')
assert.ok(calls.spawns[0].signal instanceof AbortSignal)
assert.ok(calls.spawns[0].prompt.some(block => block.text.includes('agent_id')))

console.log('PASS: Wake and Spawn use the standard subagent APIs')
