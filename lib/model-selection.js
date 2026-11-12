// Model selection for Team Progress, backed by the native Agent model store.

export function pickSelection(source) {
  if (source === null || typeof source !== 'object') return null
  const provider = typeof source.provider === 'string' ? source.provider : undefined
  const model = typeof source.model === 'string' ? source.model : undefined
  if (provider === undefined || model === undefined) return null
  return {
    provider,
    model,
    ...typeof source.reasoningEffort === 'string' ? { reasoningEffort: source.reasoningEffort } : {}
  }
}

export function messageOf(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

async function readCatalog(sessionController) {
  if (!sessionController) return { ok: false, reason: 'sessionController is not mounted in this deployment' }
  try {
    const catalog = await sessionController.modelCatalog()
    return catalog === null || typeof catalog !== 'object'
      ? { ok: false, reason: 'sessionController.modelCatalog() returned no catalog' }
      : { ok: true, catalog }
  } catch (error) {
    return { ok: false, reason: `sessionController.modelCatalog() failed: ${messageOf(error)}` }
  }
}

function validateSelection(catalog, request) {
  const group = (catalog.groups ?? []).find(candidate => candidate.id === request.provider)
  if (group === undefined) {
    const failure = (catalog.failures ?? []).find(entry => entry.id === request.provider)
    const detail = failure === undefined
      ? `provider ${JSON.stringify(request.provider)} is not routable`
      : `provider ${JSON.stringify(request.provider)} failed to load: ${failure.message}`
    return { ok: false, reason: `${detail}. Routable providers: ${(catalog.routableProviders ?? []).join(', ') || '(none)'}` }
  }
  const entry = (group.models ?? []).find(candidate => candidate.id === request.model)
  if (entry === undefined) {
    const allowed = (group.models ?? []).map(candidate => candidate.id).join(', ') || '(none)'
    return { ok: false, reason: `model ${JSON.stringify(request.model)} is not routable under provider ${JSON.stringify(request.provider)}. Models under ${request.provider}: ${allowed}` }
  }
  if (request.reasoningEffort === undefined) return { ok: true, selection: { provider: group.id, model: entry.id } }
  const efforts = entry.reasoning?.efforts ?? []
  if (efforts.length === 0) return { ok: false, reason: `model "${request.provider}/${request.model}" declares no reasoning efforts. Omit reasoningEffort for this model.` }
  const match = efforts.find(candidate => candidate.id === request.reasoningEffort)
  if (match === undefined) return { ok: false, reason: `reasoningEffort ${JSON.stringify(request.reasoningEffort)} is not valid for ${request.provider}/${request.model}. Allowed: ${efforts.map(candidate => candidate.id).join(', ')}` }
  return { ok: true, selection: { provider: group.id, model: entry.id, reasoningEffort: match.id } }
}

async function readRoster(subagents, caller) {
  if (!subagents || !caller) return { ok: false, reason: 'no subagent tree in this deployment' }
  try {
    const root = subagents.rootOf(caller)
    const entries = await subagents.listDescendants(root.id)
    const leadSessionId = String(root.id)
    const members = [
      { id: leadSessionId, name: 'lead', role: 'lead', status: 'running', leadSessionId },
      ...entries.filter(entry => entry.kind === 'child').map(entry => ({
        id: entry.id,
        name: entry.path ?? entry.id,
        role: 'teammate',
        status: entry.activity,
        mode: entry.mode,
        leadSessionId,
        ...entry.label === undefined ? {} : { description: entry.label }
      }))
    ]
    return { ok: true, members, leadSessionId }
  } catch (error) {
    return { ok: false, reason: `listDescendants() failed: ${messageOf(error)}` }
  }
}

async function resolveTarget(deps, caller, target) {
  if (typeof target !== 'string' || target.length === 0) return { ok: false, reason: 'target must be a non-empty teammate name or session id' }
  let roster
  if (caller) {
    roster = await readRoster(deps.subagents(), caller)
  } else {
    for (const root of rosterCallers(deps, undefined)) {
      const candidate = await readRoster(deps.subagents(), root)
      if (!candidate.ok) continue
      if (candidate.members.some(member => member.name === target || member.id === target)) {
        roster = candidate
        break
      }
    }
    if (roster === undefined) roster = { ok: false, reason: 'no matching subagent tree' }
  }
  if (roster.ok) {
    const member = roster.members.find(candidate => candidate.name === target || candidate.id === target)
    if (member !== undefined) {
      return {
        ok: true,
        sessionId: member.id,
        resolvedBy: member.name === target ? 'teammate-name' : 'session-id',
        member
      }
    }
  }
  const agents = deps.agents()
  const live = agents?.get(target)
  if (live !== undefined && live !== null) return { ok: true, sessionId: String(live.id), resolvedBy: 'session-id', agent: live }
  const sessionQuery = deps.sessionQuery()
  if (sessionQuery) {
    try {
      await sessionQuery.readSession(target)
      return { ok: true, sessionId: target, resolvedBy: 'session-id' }
    } catch {}
  }
  const names = roster.ok ? roster.members.map(member => member.name).join(', ') : ''
  return { ok: false, reason: `nothing named ${JSON.stringify(target)} is visible: it is not a teammate name and not a readable session id${roster.ok ? `. Known teammate names: ${names}` : ` (${roster.reason})`}` }
}

function selectedSelection(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'model/selection') return pickSelection(events[index].data)
  }
  return null
}

function lastRequestHeader(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'request/header') return events[index].data?.header
  }
  return undefined
}

function headerSelection(header) {
  if (header === null || typeof header !== 'object' || header.config === null || typeof header.config !== 'object') return null
  return pickSelection({
    provider: header.config.provider,
    model: header.config.model,
    ...header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: header.config.reasoningEffort }
  })
}

function readAgentModel(agent) {
  const session = agent?.session
  if (!session) return { readError: `agent ${String(agent?.id)} exposes no session log to read` }
  let events
  try {
    events = session.snapshotEvents()
  } catch (error) {
    return { readError: `session log unreadable for ${String(agent?.id)}: ${messageOf(error)}` }
  }
  let header
  try {
    header = session.requestHeader()
  } catch (error) {
    return { readError: `request header unreadable for ${String(agent?.id)}: ${messageOf(error)}` }
  }
  return {
    selected: selectedSelection(events),
    inEffect: headerSelection(header),
    origin: typeof session.header?.origin === 'string' ? session.header.origin : undefined
  }
}

async function readSessionModel(sessionQuery, sessionId) {
  if (!sessionQuery) return { readError: `session ${String(sessionId)} is not live and no sessionQuery service is mounted` }
  let snapshot
  try {
    snapshot = await sessionQuery.readSession(sessionId)
  } catch (error) {
    return { readError: `session log unreadable for ${String(sessionId)}: ${messageOf(error)}` }
  }
  const events = snapshot?.events
  if (!Array.isArray(events)) return { readError: `session log for ${String(sessionId)} returned no event array` }
  return {
    selected: selectedSelection(events),
    inEffect: headerSelection(lastRequestHeader(events)),
    origin: typeof snapshot?.session?.origin === 'string' ? snapshot.session.origin : undefined
  }
}

function rosterCallers(deps, caller) {
  if (caller) return [caller]
  const agents = deps.agents()
  const subagents = deps.subagents()
  if (!agents || !subagents) return []
  try {
    return agents.list().filter(agent => {
      try {
        return subagents.rootOf(agent) === agent
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

async function teamIndex(deps, caller) {
  const index = new Map()
  for (const root of rosterCallers(deps, caller)) {
    const roster = await readRoster(deps.subagents(), root)
    if (!roster.ok) continue
    for (const member of roster.members) if (!index.has(member.id)) index.set(member.id, member)
  }
  return index
}

export async function readModelState(deps, caller) {
  const controller = deps.sessionController()
  const catalogResult = await readCatalog(controller)
  const index = await teamIndex(deps, caller)
  const agentsService = deps.agents()
  const live = agentsService?.list() ?? []
  const sources = []
  const seen = new Set()
  for (const agent of live) {
    const sessionId = String(agent.id)
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    sources.push({ sessionId, agent, member: index.get(sessionId) })
  }
  for (const [sessionId, member] of index) {
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    sources.push({ sessionId, agent: undefined, member })
  }

  const rows = []
  for (const source of sources) {
    const { sessionId, agent, member } = source
    const read = agent === undefined
      ? await readSessionModel(deps.sessionQuery(), sessionId)
      : readAgentModel(agent)
    rows.push({
      target: typeof member?.name === 'string' ? member.name : sessionId,
      sessionId,
      kind: member === undefined ? 'agent' : member.role === 'lead' ? 'lead' : 'teammate',
      live: agent !== undefined,
      settable: member?.mode !== 'external',
      ...member?.leadSessionId === undefined ? {} : { leadSessionId: member.leadSessionId },
      ...typeof member?.status === 'string' ? { teamStatus: member.status } : {},
      ...read.readError === undefined
        ? { selected: read.selected, inEffect: read.inEffect }
        : { readError: read.readError }
    })
  }
  return {
    agents: rows,
    ...catalogResult.ok
      ? {
          defaultSelection: pickSelection(catalogResult.catalog.default),
          routableProviders: [...(catalogResult.catalog.routableProviders ?? [])]
        }
      : { catalogError: catalogResult.reason }
  }
}

export async function readPickerCatalog(deps) {
  const result = await readCatalog(deps.sessionController())
  if (!result.ok) return { ok: false, reason: result.reason }
  const catalog = result.catalog
  const routable = new Set(catalog.routableProviders ?? [])
  return {
    ok: true,
    defaultSelection: pickSelection(catalog.default),
    groups: (catalog.groups ?? [])
      .filter(group => routable.size === 0 || routable.has(group.id))
      .map(group => ({
        id: group.id,
        name: group.name,
        models: (group.models ?? []).map(model => ({
          id: model.id,
          name: model.name,
          efforts: (model.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name })),
          ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }
        }))
      })),
    failures: (catalog.failures ?? []).map(failure => ({ id: failure.id, message: failure.message }))
  }
}

function captureDefault(defaults) {
  if (!defaults || typeof defaults.currentSelection !== 'function') return {}
  const previous = pickSelection(defaults.currentSelection())
  return previous === null ? {} : { previous }
}

async function applyRootSelection(deps, sessionId, selection) {
  const controller = deps.sessionController()
  if (!controller) throw new Error('sessionController is not mounted, so no model selection can be applied')
  const defaults = deps.agentDefaultModel?.()
  const { previous } = captureDefault(defaults)
  let result
  try {
    result = await controller.selectModel({ sessionId, ...selection })
  } finally {
    if (previous !== undefined && typeof defaults.saveSelection === 'function') {
      await defaults.saveSelection(previous)
    }
  }
  const selected = pickSelection(result?.selected)
  if (selected === null) throw new Error(`selectModel returned no normalized selection for session ${sessionId}`)
  return selected
}

/** Set one model on a root session or a native subagent. */
export async function setModelState(deps, trace, request) {
  const resolved = await resolveTarget(deps, request.caller, request.target)
  if (!resolved.ok) throw new Error(resolved.reason)
  const catalogResult = await readCatalog(deps.sessionController())
  if (!catalogResult.ok) throw new Error(catalogResult.reason)
  const requested = {
    provider: request.provider,
    model: request.model,
    ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }
  }
  const validated = validateSelection(catalogResult.catalog, requested)
  if (!validated.ok) throw new Error(validated.reason)
  const llm = deps.llm?.()
  if (llm && typeof llm.resolveCallConfig === 'function') {
    await llm.resolveCallConfig(validated.selection)
  }

  if (resolved.member?.role !== 'teammate') {
    const selected = await applyRootSelection(deps, resolved.sessionId, validated.selection)
    return { target: request.target, sessionId: resolved.sessionId, resolvedBy: resolved.resolvedBy, requested, selection: selected }
  }

  const agents = deps.agents()
  let agent = agents?.get(resolved.sessionId)
  let resumed = false
  if (agent === undefined || agent === null) {
    const subagents = deps.subagents()
    if (!subagents) throw new Error('subagents is not mounted, so the cold teammate cannot be resumed')
    const root = request.caller ?? agents?.get(resolved.member.leadSessionId)
    if (!root) throw new Error('the cold teammate\'s live root could not be resolved')
    const signal = request.signal ?? new AbortController().signal
    await subagents.sendMessage(
      root,
      resolved.sessionId,
      [{ type: 'text', text: 'Resume for a model change.' }],
      { signal }
    )
    resumed = true
    agent = agents?.get(resolved.sessionId)
  }
  if (!agent || typeof agent.model?.select !== 'function') {
    throw new Error(`session ${resolved.sessionId} does not expose Agent-owned model selection`)
  }
  agent.model.select(validated.selection)
  return {
    target: request.target,
    sessionId: resolved.sessionId,
    resolvedBy: resolved.resolvedBy,
    requested,
    selection: validated.selection,
    ...resumed ? { resumed: true } : {}
  }
}
