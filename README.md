# dsh-team-progress

A DeepSeek Harness GUI plugin showing four views of a running agent team, counted from
durable state: who is on what, which defects are tracked, how far the goal has moved,
and what needs a human now. A source it cannot read renders `unavailable` with the
reason instead of a `0`.

The host half (`lib/index.js`) registers one loopback JSON route
`POST /api/team-progress/rpc` on the `webServer` service; the client half
(`lib/client.js`) registers the panel with the slot service and re-reads that route
every 5 seconds while the panel is open.

## The panel

```
STALLED  task task-5   owner beta is inactive        ← 4. act now, FIRST
BLOCKED  task task-6   waiting on task-4

3/6 tasks · 2/3 members                               ← headline
▓▓▓▓▓▓▓░░░▓

MEMBERS   4                                          ← 1. who is on what
  member   status    claimed task    task status
  lead     running   task task-6     pending
  alpha    running   task task-4     in progress
  beta     inactive  task task-5     in progress   STALLED
  gamma    running   no claimed task

DEFECTS   10 fixed · 5 in flight · 4 open (19)       ← 2. tracked defects
  #2   Repo→app mapping is dead code.
  #17  False CRITICAL.
  +2 more open

GOAL      round 7/256 · active · armed               ← 3. goal progress
  Extend dsh-team-progress with the four views
```

```
conversation.view   id "team-progress", order 30   a "Team progress" session tab
POST /api/team-progress/rpc   { method: "state" }  the payload
```

The panel is one `conversation.view` tab, bound to the session it was opened in. The
registration at `mount()` in `lib/client.js` is the authority on what is rendered: it
registers that tab and nothing else.

## What it adds

- **MEMBERS** — one row per member: live status, the shared task it claims, that
  task's status. A member holding nothing renders `no claimed task`.
- **DEFECTS** — counts by status across the configured defect logs, plus the rows
  still open. Recognised: `open` / `in flight` / `fixed` / `closed as superseded`;
  anything else is counted as `other` and displayed as `unclassified`.
- **GOAL** — rounds begun against the cap, the phase, and `armed` / `disarmed`.
- **STALLED / BLOCKED** — the action list, rendered first because a stall is the only
  state that asks for a decision.
- **One RPC route** — `POST /api/team-progress/rpc`, methods `state` and `act`.
- **One optional action surface** — complete / reopen / claim / release / reassign, wake,
  interrupt, spawn, auto-assign, broadcast, member cap, all through the same domain
  methods the model's own tools call. Off by default; see [Security](#security-the-action-surface).

## Requirements

The read path was traced against **DeepSeek Harness 0.2.1-rc.3** (2026-10-24), and the
plugin was last exercised end to end on **0.2.1-rc.5** (2026-11-03): a
`POST /api/team-progress/rpc` with `{"method":"state"}` answered `200` with a live
payload. No minimum version is declared.

- The client half is declared for the `web` platform (`dsh.client.platform`). It is
  browser-plane code, so importing `dsh-team-progress/client` in Node fails with
  `window is not defined` — that is the plane, not a defect.
- Only `webServer` is a hard injection. `agents`, `agentTeams`, `sessionProjections`,
  `goals`, `sessionQuery` and `uiWorkspace` are resolved lazily, so a profile with one
  of those bundles disabled still loads the panel and reports the source.

## Install

A local, unpublished plugin package (`"private": true`): `package.json` declares
`dsh.bundle.patch` (`./cordis.patch.yml`) and the client bundle (`./lib/client.js`,
platform `web`).

`cordis.patch.yml` ships exactly one row and no config:

```yaml
- insert:
    - id: team-progress
      name: 'dsh-team-progress'
```

**That file does not enable the plugin.** It is the bundle's own patch, applied only
once the bundle is enabled somewhere; enabling is a profile change that affects every
session, so it is left to the profile owner.

To enable it, three steps.

**1. Clone, then make the package resolvable to the profile.** A profile resolves
plugin packages from its own `package.json`, so add the checkout as a `link:`
dependency and run the profile's install (the profile directory ships a
`pnpm-workspace.yaml`):

```bash
git clone https://github.com/ucfjoe/dsh-team-progress.git ~/dsh-team-progress

PROFILE=~/.dsh/profiles/desktop          # the profile you run
# in "$PROFILE/package.json":
#   "dependencies": { …, "dsh-team-progress": "link:$HOME/dsh-team-progress" }
cd "$PROFILE" && pnpm install
ls -l node_modules/dsh-team-progress     # expect a symlink to the checkout
```

This step was run from a fresh clone on pnpm 11.22.0 / Node v26.7.0: the symlink
appears, `import('dsh-team-progress')` resolves the host half (`apply`, `inject`,
`name`), and `npm test` passes inside the clone.

**2. Add the row to the profile's `cordis.patch.yml`.**

```yaml
- id: team-progress
  name: 'dsh-team-progress'
  config:
    defectLogs:
      - ~/repos/your-project/docs/defects.md
    allowMutations: false
```

The `- insert:` wrapper shown above is also accepted. `~` is expanded in `defectLogs`
entries and empty entries are ignored.

**3. Reload.** After editing the host half, a file edit is not enough — the module is ESM
inside the app process, so reload the plugin (disable, then enable) to re-import it and
rebuild the client bundle. Recorded in [the development log](docs/DEVLOG.md).

## Configuration

Every key is optional; the defaults below are the ones `lib/index.js` applies.

| key | default | what it does |
|---|---|---|
| `defectLogs` | `[]` | Paths to markdown defect logs, absolute or `~/…`. Empty is the shipped default and makes the defects view report `unavailable: no defect-log paths are configured`. Read from config only, never from the request body. |
| `allowMutations` | `false` | Enables the `act` method. Off means `act` answers `403 TEAM_PROGRESS_ACTIONS_DISABLED`; every view keeps working. |
| `actionPolicy` | `'all'` | Narrows the actions reachable once `allowMutations` is on. `'read-write'` withholds the two that outlive the click — `spawn` (creates an agent) and `member-limit` (rewrites a config file on disk) — answering `403 TEAM_PROGRESS_ACTION_WITHHELD` and reaching no domain method. Every board action still runs. An absent or unrecognised value resolves to `'all'`, so an existing profile is unchanged; the payload's `actions.policy` always names the value in force. |
| `spawnFreshProvider` | `'spawn'` | Provider name passed to `spawnTeammate` for a `fresh`-context spawn. |
| `spawnForkProvider` | `'fork'` | Provider name passed to `spawnTeammate` for a `fork`-context spawn. |
| `aliasFile` | `~/.dsh/team-progress/aliases.json` | JSON store for the panel-owned display alias, one-line purpose and hidden flag per member, keyed `leadId\|memberId`. |
| `homePatchFile` | `~/.dsh/cordis.patch.yml` | The patch layer the `member-limit` action edits, with a timestamped backup written beside it. |

### The defect-log format

The parser reads markdown tables. A table counts when its header row has a `Status`
column and a column matching `Defect` / `Issue` / `Problem` / `Bug`, immediately
followed by the separator row:

```markdown
| # | Defect | Evidence | Status |
|---|---|---|---|
| 2 | Repo→app mapping is dead code. | investigate.py:319-321 | **open** |
| 17 | False CRITICAL. | run.log | **fixed** #222 — merged |
```

- A status cell resolves to `open`, `in flight` (or `in-flight`), `fixed` or
  `closed as superseded`. The cell is cut at the first `,` `;` `:` `—` `–` `(` `#` or
  ` - `, so a trailing reference (`**fixed #222** — merged`) does not change the
  state; a `**bold**` phrase is read from inside the emphasis.
- **A state outside those four is counted as `other`**, not dropped and not guessed
  at, so a new phrasing shows up as `unclassified` instead of disappearing.
- An escaped `\|` does not split a cell. A blank line does not end a table while the
  next non-blank line is still a data row; a heading, a separator, a new header or
  prose does. Section headings are carried on each row.
- Counts are `fixed` / `inFlight` / `open` / `superseded` / `other` / `total`. Open rows
  are capped at 50 with `openTruncated` carrying the remainder; a file over 4 MiB is
  refused and a table stops at 5000 rows.

## Security: the action surface

`POST /api/team-progress/rpc` is registered **directly on the web server, outside the
app's own auth middleware.** With `allowMutations: true`, any local process — any
script, any tool, any agent on the machine — can drive the team board through this
route: complete, reopen, claim or reassign a shared task, wake an inactive member,
interrupt a running agent, spawn a teammate, broadcast to the whole team.

- The shipped default is **off** (`allowMutations: false`).
- With it off, `act` answers **`403 TEAM_PROGRESS_ACTIONS_DISABLED`** and reaches no
  domain method. The read views, the counts and the read path keep working unchanged.
- Turn it on deliberately, on a single-user machine, and treat the route as a local
  control socket rather than an authenticated API.
- `actionPolicy: 'read-write'` narrows it further without turning it off: `spawn` and
  `member-limit` answer **`403 TEAM_PROGRESS_ACTION_WITHHELD`** while every board action
  keeps working. Those two are the ones that outlive the click — one creates a live
  agent with model budget attached, the other rewrites a config file on disk.
  Withholding is opt-in, so the value an existing profile already means (`'all'`) stays
  the default rather than being re-interpreted under it.

Paths in `defectLogs` come from config only, never from the request, so the route
cannot be turned into an arbitrary-file reader. The body is capped at 64 KiB.

## Payload / RPC contract

Exact path, `no-store`.

Two methods: `state` takes `{ sessionId? }` and answers the snapshot below; `act` takes
`{ leadId, action, … }` and answers a receipt, or a refusal with a domain `code`.

Input handling: non-`POST` → `405`; body over 64 KiB → `413`; invalid JSON, JSON
that is not an object, or a `method` that is missing / empty / not a string → `400`;
a method that is not registered (including `constructor`, `__proto__`, `toString`) →
`404`; `act` while mutations are off → `403` `TEAM_PROGRESS_ACTIONS_DISABLED`.

```jsonc
{
  "ok": true,
  "generatedAt": "2026-10-30T11:02:50.000Z",   // ISO, host clock at read time
  "summary": { "total": 6, "completed": 3, "inProgress": 2, "pendingReady": 0,
               "blocked": 1, "stalled": 1, "members": { "live": 2, "total": 3 } },
  "teams": [ /* one card per lead: label, summary, roster, lanes, goal, lineage */ ],
  "roster": { "state": "ok", "leads": 1, "stalled": 1, "members": [ /* rows */ ] },
  "defects": {
    "state": "ok",                              // ok | partial | unavailable
    "files": [{ "path": "…", "state": "ok", "rows": 19 }],
    "counts": { "fixed": 10, "inFlight": 5, "open": 4, "superseded": 0,
                "other": 0, "total": 19 },
    "open": [ /* rows */ ], "openShown": 1, "openTruncated": 3
  },
  "goal": { "state": "ok", "goals": [ /* roundsStarted, maxGoalRounds, phase */ ] },
  "waitingOnYou": { "state": "ok", "total": 3, "stalled": 1, "unassigned": 2, "idle": 0 },
  "attention": [ { "kind": "stalled", "label": "task-5", "detail": "owner beta is inactive" } ],
  "actions": { "enabled": false, "policy": "all" },
  "degraded": { "any": false, "reasons": [] }
}
```

### The honesty rules

- **`null` is never `0`.** A count that could not be read is `null`, and the view says
  why. `completed + inProgress + pendingReady + blocked === total` holds on every
  readable snapshot.
- **An absent source is not a zero.** Each view carries its own `state` (`ok` /
  `partial` / `none` / `unavailable`) and, when it is not `ok`, the reason. A missing
  defect log is `unavailable` with `counts: null`; one log readable and one missing is
  `partial` with the real counts and the missing file named. `none` ("there is no
  goal") and `unavailable` ("I could not look") are different answers, and render
  differently.
- **Three-valued on purpose.** `stalled` is `true`, `false`, or `null` when the live
  status could not be read; a `null` draws no badge rather than claiming "not stalled".
- **`degraded` is narrow.** It covers the board and team read only, so a missing defect
  file states itself in place without making a readable task board look degraded.
- **Nothing is estimated.** No ETA, no percentage, no elapsed time.

## Tests

Run `npm test`. Both suites pass; they were run here on Node v26.7.0.

- `test/verify.mjs` — renders the real client bundle through a React shim and asserts
  each view, including every absence: attention first in document order, a `STALLED`
  badge only where the status is known, and no invented `0` anywhere.
- `test/verify-host.mjs` — drives the host half against a fixture board and asserts the
  payload, the read path (one `tryMembership` per lead, zero `agents.get()` calls), the
  RPC status codes, and that a request cannot redirect a defect-log path.

## Design notes

- **A member's claimed task beats the description it was spawned with.** The
  description is fixed at spawn and drifts as work moves; the task the member holds is
  the durable answer to "what is it doing".
- **`provisioning` is not a stall.** Building a teammate is a normal startup state.
  Only `inactive` or `failed` while holding in-progress work counts, and an unknown
  status yields `null` rather than `false`.
- **A reader that throws must render `unavailable`, never "no goal".** The goal
  service's `get()` throws for an agent that is not the registry's live instance, so
  every call is wrapped: conflating "could not look" with "there is none" would report
  success on a broken read.
- **A source that cannot be read is not a zero.** A missing file, an unregistered
  service and an unreadable board each say so in their own field, because a fabricated
  `0` reads as a fact.
- **The flag that lets the panel act is off by default.** A read-only panel is safe on
  any profile; a route that can wake agents and move a shared board is an explicit
  owner decision.

## License

MIT — see [LICENSE](LICENSE) and the `license` field in `package.json`.
