# Team Progress Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live per-agent and per-task provider/model/reasoning selection to Team Progress.

**Architecture:** Use the Agent-owned model store for existing teammates and native `agentOptions` for new subagents. Reuse `/api/agent-models/rpc` for the picker and live state, then pass validated selections through Team Progress spawn and auto-assign.

**Tech Stack:** JavaScript ESM host plugins, non-ESM browser bundles, Node's built-in test assertions, native DSH `agent.model.select`, `subagents.startActivation`, and `llm.resolveCallConfig`.

**Spec:** `docs/superpowers/specs/2026-11-12-team-progress-model-selection-design.md`

## Global Constraints

- Do not use `sessionController.selectModel` for subagent-owned Sessions.
- Do not call `agents.resume()` directly for cold teammates; use native subagent delivery.
- Existing root-session selection and deployment-default restoration stay unchanged.
- Failed selection must not be reported as applied and must block auto-assignment.
- Commit bodies must contain `[Claude_Code]`.

## Review Focus

- Cold teammate resumes, then receives the selection without a replacement Session (Task 1).
- Invalid provider/model/effort leaves the current model unchanged (Task 1).
- Existing idle teammate fails selection during auto-assign, so its assignment stops (Task 2).
- New Spawn and auto-assign agents receive identical `agentOptions` (Task 2).
- Picker shows current model and refreshes after set (Task 3).
- Root-session selection still restores the deployment default (Task 1).

---

### Task 1: Live and cold teammate model switching

**Files:**
- Create: `lib/model-selection.js`
- Modify: `lib/index.js`
- Test: `test/live-model-selection.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `resolveTarget()`, `validateSelection()`, `readRoster()`, `deps.agents()`, `deps.subagents()`, `deps.llm()`, and `deps.sessionController()`.
- Produces: `setModelState()` returns `{ target, sessionId, resolvedBy, requested, selection, resumed?: boolean }` with `selection` actually recorded by `agent.model.select()`.

- [ ] **Step 1: Write the failing test**

Cover two cases: a live teammate calls `agent.model.select(selection)` without `sessionController.selectModel`; a cold teammate calls `subagents.sendMessage()` first, then selects on the resumed live Agent. Also cover invalid selection causing no resume and no model change, and root behavior retaining the existing default restore.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/live-model-selection.mjs`
Expected: FAIL because subagent targets still use the generic controller path.

- [ ] **Step 3: Implement selection in `lib/model-selection.js` and expose it from `lib/index.js`**

Keep `applySelection()` unchanged for root sessions. In `setModelState()`, detect a teammate from the resolved roster. Validate through the catalog and `llm.resolveCallConfig(selection)`. For a live teammate call `agent.model.select(selection)`. For a cold continuable teammate, call `subagents.sendMessage(caller, sessionId, [{ type: 'text', text: 'Resume for a model change.' }], { signal })`, then select on the resumed live Agent. Return `resumed: true` only for the cold path.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/live-model-selection.mjs`
Expected: all live, cold, invalid, and root-default checks pass.

- [ ] **Step 5: Commit**

```bash
git add lib/model-selection.js lib/index.js test/live-model-selection.mjs package.json
git commit -m "feat: switch subagent models live" -m "[Claude_Code]"
```

### Task 2: Model options on Spawn and auto-assign

**Files:**
- Modify: `lib/index.js`
- Test: `test/model-options-host.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 selection semantics and native `startActivation({ provider, name, label, prompt, parent, agentOptions, signal, delivery })`.
- Produces: Spawn and auto-assign accept optional `{ provider, model, reasoningEffort? }` and apply it to existing idle teammates before reassignment and to every new activation.

- [ ] **Step 1: Write the failing test**

Assert Spawn forwards the exact `agentOptions`. Assert auto-assign selects on an existing idle teammate before `updateTask`, uses the same options for a spawned agent, and aborts that assignment when existing-teammate selection fails.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/model-options-host.mjs`
Expected: FAIL because no `agentOptions` path exists.

- [ ] **Step 3: Implement host model options**

Resolve optional model options once per action. Validate with `llm.resolveCallConfig()`. Pass options into each `startActivation`. Before reassigning an existing teammate, use the Task 1 live/cold selection path through the shared plugin services, then resolve the owner Session id. Do not proceed with that reassignment if selection fails.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/model-options-host.mjs`
Expected: all Spawn, existing-idle, new-spawn, and failure-path checks pass.

- [ ] **Step 5: Commit**

```bash
git add lib/index.js test/model-options-host.mjs package.json
git commit -m "feat: add model options to team actions" -m "[Claude_Code]"
```

### Task 3: Team Progress model controls

**Files:**
- Modify: `lib/client.js`
- Test: `test/model-controls-client.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `/api/team-progress/rpc` methods `models` and `model-set`; Team Progress Spawn and auto-assign options from Task 2.
- Produces: teammate model controls and Spawn/auto-assign provider/model/effort controls.

- [ ] **Step 1: Write the failing test**

Assert current `inEffect` model and effort render per teammate, changing a selection posts `{ method: 'model-set', args: { sessionId, provider, model, reasoningEffort } }`, Spawn forwards model options, auto-assign forwards model options, and successful changes refresh model state.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/model-controls-client.mjs`
Expected: FAIL because no model controls exist.

- [ ] **Step 3: Implement browser model state and controls**

Load the `models` method alongside Team Progress state. Index returned agents by `sessionId`. Add provider/model/effort controls to teammate rows and Spawn/auto-assign, preserving current values and disabled states. Refresh both state sources after `model-set`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/model-controls-client.mjs`
Expected: all render, request, forward, and refresh checks pass.

- [ ] **Step 5: Commit**

```bash
git add lib/client.js test/model-controls-client.mjs package.json
git commit -m "feat: add model controls to team progress" -m "[Claude_Code]"
```

### Task 4: Full and live verification

**Files:**
- Modify: `package.json` only if test registration changed earlier.
- No production changes expected.

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run every offline suite**

Run: `npm test` in `dsh-agent-models` and `dsh-team-progress`, plus `node bugs/dsh-agent-team-config-regression.test.mjs` in `cart-planning`.
Expected: every check passes.

- [ ] **Step 2: Reload the plugins**

Disable and re-enable `include:agent-models` and `include:team-progress` with `plugin_manager`.
Expected: both entries return `application: applied`.

- [ ] **Step 3: Verify live model switching**

Switch one running teammate and one cold teammate through `/api/team-progress/rpc` with `model-set`. Spawn one panel agent with an explicit model and effort. Read `models` and `state` afterward.
Expected: both switched members use the selected model on later requests; the new member starts with the requested model; the panel renders all members without degraded errors.

- [ ] **Step 4: Commit verification-only changes**

```bash
git add package.json docs/superpowers
git commit -m "test: cover team model selection" -m "[Claude_Code]"
```
