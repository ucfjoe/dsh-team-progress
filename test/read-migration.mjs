import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const session = { id: 'session-lead', header: { id: 'session-lead', createdAt: 1 }, seq: 1 }
const lead = { id: 'session-lead', status: 'running', session }
const child = { id: 'session-child', status: 'inactive', session: { id: 'session-child', header: { id: 'session-child', createdAt: 2 }, seq: 1 } }
const descendants = [{
  kind: 'child',
  id: 'session-child',
  parentId: 'session-lead',
  depth: 1,
  path: 'native-verify',
  label: 'Verify native Agent Team creation',
  mode: 'continuable',
  activity: 'inactive',
  hasChildren: false
}]
const subagents = {
  rootOf: agent => agent === lead || agent === child ? lead : undefined,
  listDescendants: async rootId => {
    assert.equal(rootId, 'session-lead')
    return descendants
  }
}
let route
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: spec => { route = spec } }
    if (name === 'agents') return { list: () => [lead, child], get: id => id === 'session-lead' ? lead : undefined }
    if (name === 'subagents') return subagents
    if (name === 'agentTeams') return { listTasks: () => [] }
    if (name === 'sessionProjections') return { stateOf: () => undefined }
    if (name === 'sessionQuery') return { filterSessions: async () => [] }
    if (name === 'goals') return { get: () => undefined }
    return undefined
  },
  effect: fn => fn(),
  logger: { info() {}, warn() {}, error() {} }
}
apply(ctx, {})

const req = {
  method: 'POST',
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ method: 'state', args: { sessionId: 'session-lead' } }))
  }
}
let payload
const res = {
  writeHead() {},
  end(text) { payload = JSON.parse(text) }
}
await route.handler(req, res)

assert.equal(payload.summary.members.total, 2)
assert.equal(payload.summary.members.live, 1)
assert.equal(payload.teams[0].roster.members[1].name, 'native-verify')
assert.equal(payload.teams[0].roster.members[1].status, 'inactive')
console.log('PASS: team-progress renders the standard subagent roster without agents.roots()')
