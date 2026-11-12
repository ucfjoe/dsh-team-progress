# Team Progress model selection

## Intent

Let the user choose the provider, model, and reasoning effort for each teammate and for work assigned through Team Progress. Model changes must work for existing teammates, not only at spawn time.

## Approved behavior

- Every teammate row exposes provider, model, and reasoning-effort controls, with the current model shown.
- Running teammates switch through `agent.model.select()`. The selection is durable and applies to later steps.
- Cold teammates resume through native subagent delivery, then receive the selection. No replacement agent or new Session is required.
- Spawn and auto-assign forms expose the same selection. New agents receive it through `agentOptions` during `startActivation`.
- For per-task work, the user can switch an existing teammate before assignment or spawn a dedicated agent with a chosen model.
- Builder call: auto-assign applies the chosen selection to existing idle teammates before reassignment and to every new agent it creates. If selection fails for an existing teammate, that assignment does not proceed.
- Existing root-session behavior remains unchanged, including restoration of the deployment default.
- Selections are validated against the live model catalog. Failures are reported; the panel never claims that an unapplied selection succeeded.

## Constraints

- `sessionController.selectModel` rejects subagent-owned Sessions, so teammate changes use the Agent-owned `agent.model.select()` store instead.
- Cold resume happens before selection. The resume control message can use the previous model; the new selection applies after it is recorded.
- Model selection at creation is not a substitute for live switching.
- Do not bypass subagent ownership with `agents.resume()` directly. Cold members use the native subagent delivery path.

## Implementation

1. Add a self-contained model-selection module to `dsh-team-progress`:
   - Resolve the target through the native subagent tree.
   - Validate against `sessionController.modelCatalog()` and `llm.resolveCallConfig()`.
   - For live teammates, call `agent.model.select(selection)`.
   - For cold teammates, use `subagents.sendMessage()` to resume, then select on the live Agent.
   - Preserve existing root-session selection and deployment-default restoration.
   - Return whether the member was resumed and the selection actually recorded.
2. Extend `dsh-team-progress`:
   - Serve the model picker and per-agent model state from its own `/api/team-progress/rpc` route.
   - Add provider/model/effort controls to teammate rows.
   - Add the same controls to Spawn and auto-assign.
   - Pass validated `agentOptions` into every new `startActivation` call.
   - Refresh both panel state and model state after a change.
3. Keep the separate `dsh-agent-models` plugin out of this feature. It remains an independent local plugin, not a dependency of this repository.

## Tests

- Unit tests for live teammate selection, cold resume-then-select, invalid routes, and unchanged deployment defaults.
- Host tests for `agentOptions` on Spawn and auto-assign.
- Client tests for current-model rendering, picker behavior, and refresh after set.
- Existing `dsh-agent-models` and `dsh-team-progress` suites must remain green.
- Live verification must prove a running teammate and a cold teammate switch models, plus a panel-spawned agent starts with the selected model.
