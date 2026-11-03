<!-- Development log for dsh-team-progress. Kept for the reasoning behind each design
     decision: the argument history, the verification notes with their dates, and the
     corrections made to earlier releases. Later sections supersede earlier ones — the
     client half, for one, is now a single `conversation.view` tab. Code line references
     describe the tree at the time of writing. For install and configuration see ../README.md. -->

# dsh-team-progress

Four views of the team's live work, counted from durable state. Answers **who is
on what, what is tracked, and how far the goal has moved** — and says so when it
cannot.

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
sidebar.panellist   id "team-progress", order 40   compact count glyph
main                key "team-progress"            the four views
POST /api/team-progress/rpc   { method: "state" }  the payload
```

View 4 sits at the **top** even though it is the owner's fourth priority: it is
the only view that means "act now". The other three follow in priority order.

## Why it looks like this

### 0.1.0 was a count-only strip, and that was two mistakes in one

The 0.1.0 panel showed `3/6 tasks · 2/3 members`, a segmented bar, and a
stalled/blocked list. It got the honesty rule right — counts only, `null` never
`0` — and then over-corrected on scope:

1. **It refused to draw member rows**, on the theory that the shipped Agent Team
   popover already drew the roster. The popover draws each member's
   `description`, which is **fixed at spawn and drifts** as work moves. The
   member's *claimed shared task* is the durable truth of what it is doing, and
   nothing surfaced that join. 0.2.0 reinstates member rows, joined on the board.
2. **It could not answer two of the owner's four questions at all** — tracked
   defects and goal progress had no source in the payload.

### The stall definition was also too wide

0.1.0 flagged a task as stalled when its owner's status was merely **not**
`running`, so a `provisioning` member counted as stuck. Building a teammate is a
normal startup state, not a failure. 0.2.0 requires `inactive` or `failed` and
reports `null` (not `false`) when the status is genuinely unknown.

## The read path (verified 2026-10-24, dsh 0.2.1-rc.3)

Verified against the shipped bundle in
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`.

Every Team read is authorized by identity, not by a role check:

- `agentTeams.listTasks(caller)` (`dsh-experimental-agent-team/lib/index.js:1546`)
  and `listMembers(caller)` (`:1498`) both resolve their caller through
  `roster.membership(agent)` (`:861`), **which throws** unless the agent is a
  live team member.
- A team is scoped to a **lead**. `tryMembership(agent)` (`:870-900`) returns
  `{ root, id, role, name }` for a live root agent.

So the host half does exactly one thing per lead:

```
agents.roots()                              dsh-agent/lib/index.js:623
  └─ per lead: agentTeams.tryMembership(lead)     ← ONE call per lead
       └─ listMembers(lead) + listTasks(lead)     ← that lead only
```

- **`agents.get()` is never called.** Member ids are not lookup keys anywhere in
  `lib/index.js`; `test/verify-host.mjs` asserts zero agent lookups and that
  `tryMembership` is only ever passed lead ids.
- **A lead with no team is skipped silently.** `tryMembership` cannot tell "no
  team" from "team of one" — it returns a *lead* shape for any live root agent
  (`:893-899`). Team-ness is decided by evidence (a roster row with
  `role === "teammate"`, or at least one task). This is why an ordinary chat does
  not produce a banner: with the projection unregistered, `journal.state()`
  throws `"Agent Teams projection is not registered"` (`:130`) for *every* plain
  conversation, which is a normal absence, not a fault.
- **The durable fallback covers the same lead set.** When the service cannot read
  a board, `sessionProjections.stateOf(lead.session, 'agentTeam')`
  (`dsh-session-projection/lib/index.js:126`) is read for that **same lead** — no
  second enumeration, no session walk. That path carries durable phase only, so
  `stalled` is `null` there.

### The goal source (0.2.0)

`goals` is a cordis service whose contract, read from the shipped `dsh-goal`
package, is:

```js
static inject = ['agents', 'sessionProjections']
get(agent) -> GoalView | undefined      // THROWS unless `agent` is the live instance
```

and its `view()` returns `{ ...goal, roundsStarted, createdAt, updatedAt,
activation }`. Two consequences that shape this plugin:

- **`roundsStarted` is not on `GoalSnapshot`** — it only appears on the view, so
  the plugin reads the view, never the snapshot.
- **`get()` throws for an agent that is not the registry's live instance**, so
  every call is wrapped. A throw must render `unavailable`, *never* `no goal`: the
  difference between "there is none" and "I could not look" is the whole point.

`activation` (`armed` / `disarmed`) is surfaced because a goal can be `active`
and `disarmed` at once after a restart without a resume — phase alone would
misreport that as live progress.

## Payload

```jsonc
{
  "ok": true,
  "generatedAt": "2026-10-30T11:02:50.000Z",     // ISO, host clock at read time
  "summary": {
    "total": 6, "completed": 3, "inProgress": 2, "pendingReady": 0,
    "blocked": 1, "stalled": 1,
    "members": { "live": 2, "total": 3 }
  },
  "roster": {
    "state": "ok",                                // ok | partial | unavailable
    "leads": 1, "stalled": 1,
    "members": [
      { "leadId": "session-a", "name": "beta", "role": "teammate",
        "status": "inactive", "claimed": 1,
        "taskId": "task-5", "taskSubject": "task task-5",
        "taskStatus": "in_progress", "stalled": true }
    ]
  },
  "defects": {
    "state": "ok",                                // ok | partial | unavailable
    "files": [{ "path": "…/live-run-defects-2026-10-30.md", "state": "ok", "rows": 19 }],
    "counts": { "fixed": 10, "inFlight": 5, "open": 4, "other": 0, "total": 19 },
    "open": [{ "ref": "2", "defect": "Repo→app mapping is dead code.",
               "evidence": "investigate.py:319-321", "status": "open",
               "section": "Blocked the investigation", "file": "…" }],
    "openShown": 1, "openTruncated": 3
  },
  "goal": {
    "state": "ok",                                // ok | none | unavailable
    "goals": [{ "leadId": "session-a",
                "objective": "Extend dsh-team-progress with the four views",
                "phase": "active", "roundsStarted": 7, "maxGoalRounds": 256,
                "activation": "armed" }]
  },
  "attention": [
    { "kind": "stalled", "label": "task-5", "detail": "owner beta is inactive" },
    { "kind": "blocked", "label": "task-6", "detail": "waiting on task-4" }
  ],
  "degraded": { "any": false, "reasons": [] }
}
```

### `summary` — the board, counted

| field | meaning |
|---|---|
| `total` | non-deleted tasks on the board. **`null`** when the board could not be read — never `0`. |
| `completed` / `inProgress` | durable task status counts. |
| `pendingReady` | `pending` whose blockers are all completed. |
| `blocked` | `pending` with an unfinished blocker. A **subset of pending**, never counted as in progress. |
| `stalled` | `in_progress` tasks whose owner is `inactive` or `failed`. **`null`** when live status *or* the roster is unavailable. |
| `members.live` / `.total` | roster rows with status `running` / all roster rows (the lead is a row). |
| `attention` | `{ kind, label, detail }`, **stalled first**, then blocked. The panel renders 3 and counts the rest. |

`completed + inProgress + pendingReady + blocked === total` holds on every
readable snapshot, and the harness asserts it.

### `roster` — member → claimed task → task status

One row per member. `task: null` (rendered `no claimed task`) is a **real
absence**, not a zero. `claimed` reports how many tasks the member owns, so
picking one for display never hides the others; the `in_progress` claim wins over
`pending`, which wins over `completed`.

`stalled` is three-valued on purpose:

| value | meaning |
|---|---|
| `true` | `inactive` or `failed` **and** its claimed task is `in_progress` |
| `false` | running, or nothing claimed, or the claim is not in progress |
| `null` | cannot say: no live status, or the roster row carries no status |

`provisioning` is never a stall — it is the normal state of a member being built.

### `defects` — counts by status plus the open rows

Parses markdown tables with a status column. The documented vocabulary is
`fixed` / `in flight` / `open`; **anything else is counted as `other`** rather
than dropped, so a new status can never silently disappear. A trailing PR or
ticket reference (`**open** — task-17`) does not change the status. Escaped pipes
inside a cell do not split the row. Section headings are carried on each row.

- A **missing file is `unavailable` with `counts: null`** — never `0`.
- One readable log and one missing is `partial`, with the real counts kept and the
  missing file named.
- `open` is capped at 50 rows with `openTruncated` carrying the remainder.

### `goal` — rounds begun against the cap

`roundsStarted` is the highest admitted round number, i.e. a count of rounds
begun. `no goal` (§ `state: "none"`) is distinct from `unavailable`, and neither
renders as `0 rounds`.

### `degraded`

`degraded` keeps its 0.1.0 meaning: the **board and team read only**. Each new
view states its own availability in place, so a missing defect file does not make
a healthy task board look degraded — and a normal absence never reads as an
incident.

| situation | `summary.total` | `degraded.reasons` |
|---|---|---|
| everything readable | number | `[]` |
| one board unreadable, others readable | sum of the readable | `["part of the task board is unreadable"]` |
| no board readable | `null` | `["the task board could not be read"]` |
| durable projection only | number | `["live member status unavailable"]` |
| no agent registry | `null` | `["the agent registry is not registered"]` |
| Agent Teams bundle disabled | `null` | `["Agent Teams is not available on this profile"]` |

## Honesty rules

- **Nothing is estimated.** Every number counts durable state: board tasks,
  claimed owners, goal rounds, defect-log rows. No ETA, no percentage, no elapsed
  time, no "likely done".
- **Stale beats blank.** A source that cannot be read renders
  `unavailable: <reason>` — the literal words and the real cause. A `0` that means
  "could not read" is the defect class this team spent the day fixing, so
  `counts: null`, `stalled: null`, and `state: "unavailable"` do the work that a
  fabricated zero used to do.
- **An unobservable stall is `null`, never `false`.** No badge is drawn, and the
  panel does not print "not stalled".
- **A quoted percent sign is not a computed one.** Defect prose is passed through
  verbatim; the panel itself never produces a `%`.
- **No animation.** No `@keyframes`, no `animation`, no transition on a bar
  segment; the bar is `data-static="1"`, so nothing implies continuous forward
  motion between samples.
- **Read-only.** No board writes, no goal mutation, no spawning.

## Configuration

```yaml
- id: team-progress
  name: 'dsh-team-progress'
  config:
    defectLogs:                                      # optional, default []
      - ~/repos/your-project/docs/defects.md
```

- Default when omitted: `[]` — no log is configured, so the defects view reports
  `unavailable: no defect-log paths are configured`.
- `~` is expanded. Empty entries are ignored.
- `defectLogs: []` is therefore the same as omitting it.
- **Paths come from config ONLY, never from the request** — the endpoint cannot be
  turned into an arbitrary-file reader.

## RPC contract

`POST /api/team-progress/rpc` — exact path, `no-store`.

| input | response |
|---|---|
| any non-`POST` | `405` |
| body over 64 KiB | `413` |
| invalid JSON | `400` |
| JSON that is not an object (`[]`, `null`, a string) | `400` |
| `method` missing, empty, or not a string | `400` |
| method not registered — **including `constructor`, `__proto__`, `toString`** | `404` |
| `state` | `200` with the payload |

A source failure is **not** an HTTP error: it is `200` with that view's
`state: "unavailable"`.

```yaml
- insert:
    - id: team-progress
      name: 'dsh-team-progress'
```

## Verification

```bash
node --check lib/index.js && node --check lib/client.js
node test/verify.mjs        # PASS — 199 checks
node test/verify-host.mjs   # PASS — 268 checks
```

`test/verify-host.mjs` covers the four views plus everything 0.1.0 pinned:

- a six-task board: exact summary, `stalled: 1` from an `in_progress` task owned
  by an **inactive** member, that item **first** in `attention`, disjoint counts
- **the read path**: `agents.roots()` once, `tryMembership` once per lead,
  `listTasks`/`listMembers`/`goals.get` only ever with the lead, and **zero**
  `agents.get()` calls
- **roster**: `STALLED` for `beta` (inactive + `in_progress`); **not** stalled for a
  `provisioning` member holding an `in_progress` task; not stalled for a running
  member; a member with no claim reports `taskId: null` and `claimed: 0`; the
  in-progress claim is preferred over a completed one
- **defects**: statuses counted exactly against fixture data (`fixed 2`,
  `inFlight 1`, `open 2`, `other 1`, `total 6`), open rows listed with their
  section, escaped pipes not splitting a row, a trailing reference not changing
  the status; **a missing file is `unavailable` with `counts: null` — never `0`**;
  one readable + one missing is `partial` with real counts; `defectLogs: []` is
  `unavailable`
- **goal**: `roundsStarted`/`maxGoalRounds`/`phase`/`activation` from the view; **no
  armed goal is `state: "none"` with no fabricated round count**; an absent service
  and a **throwing `get()`** are both `unavailable`, never "no goal"
- **hostile caller**: `constructor`/`__proto__`/`toString`/`hasOwnProperty`/`valueOf`
  all `404`; the body cannot pollute `Object.prototype`; array/null/non-string
  bodies `400`; a 200 KiB body `413`; **request args cannot redirect the
  defect-log path**
- a plain chat lead whose board read fails is skipped silently, **not** degraded
- a board whose reads both fail: `total: null`, every count `null`, roster still
  reported
- the durable-projection path: real counts, `stalled: null`, roster `partial`
- a roster that throws: counts kept, `members.total: null`, explicit reason
- no agent registry: all nulls, explicit reason
- invariants: disjoint counts, no legacy `unknown` block, no `eta` / `percentage` /
  `elapsed` field

`test/verify.mjs` renders the real bundle through a React shim and asserts each
view:

- **attention is FIRST in document order**, above the headline, and three rows max
  with `+2 more`
- **members**: `stalled`/`STALLED` badge for beta only, `data-claim` carrying the
  claimed task id rather than the spawn description, and `no claimed task` for
  gamma — with **no** `"0"` ever reported as a claim
- **defects**: `fixed 10`, `in flight 5`, `open 4`, `(19)`, `#2`, `+2 more open`
- **goal**: the objective verbatim, `round 7/256`, the phase, `armed`
- **every source unreadable**: three `unavailable:` lines, no `open 0`, no
  `round 0`, no `fixed 0`, no invented member rows
- **no goal** renders `no goal`, not `round 0` and not `rounds unavailable`
- a goal with no cap renders `rounds unavailable` and never `/0`
- **no live status**: roster `partial`, no invented `STALLED` badge
- a defect description containing `0.001%` is quoted verbatim, while no
  *computed* figure contains a `%`
- no `<table>`, no model column, no animation/keyframes/segment transition

## Corrections made to 0.1.0 in 0.2.0

1. **The `stalled` predicate was too wide.** It fired for any status that was not
   `running`, so a `provisioning` member holding an `in_progress` task was reported
   as stalled — a false alarm on a normal spawn. Now `inactive`/`failed` only, and
   `unknown` yields `null`.
2. **`handlers[String(input.method)]` reached the prototype chain.** `method:
   "constructor"` resolved `Object`, was found truthy, and returned **`200`**
   instead of `404`; `hasOwnProperty`/`valueOf` likewise. The handler map is now
   `Object.create(null)`, so an unregistered method is always a `404`.
3. **Malformed JSON was reported as `500`.** A client mistake was reported as a
   server fault. It is a `400` now, along with a JSON array, `null`, a missing
   method, and a non-string method.
4. **No cap on the request body.** A loopback `POST` could buffer without limit.
   Now capped at 64 KiB while streaming → `413`.
5. **The client harness forbade member rows.** `test/verify.mjs` asserted that no
   per-member row could exist, which contradicted the owner's first requirement.
   That assertion is replaced by ones that pin what the member row must *contain*
   (claimed task, task status, three-valued stall).

---

# 0.3.0 — the action surface

0.2.0 answered four questions and let you do nothing about the answers. 0.3.0
keeps every honesty invariant and adds the controls a Lead actually reaches for
when a row says `STALLED`.

## What you can do now

| Control | Where | What it calls | Authority |
|---|---|---|---|
| **Wake** / **Nudge** | every teammate row | `ctx.agentTeams.sendMessage(lead, { target, content })` | as the Lead |
| **Stop** | a running teammate row | `ctx.agentTeams.interrupt(lead, target)` | as the Lead |
| **Complete** | a teammate row holding a claim | `ctx.agentTeams.updateTask(lead, { taskId, expectedRevision, action: 'complete' })` | as the Lead, CAS on the revision the panel displayed |
| **member name** | every teammate row | `uiWorkspace.openSession({ parentSessionId, childSessionId, mode: 'continuable' })` | navigation, no mutation |

Every mutation goes through the same domain methods the model's own tools call,
so `ctx.agentTeams` keeps its own authority checks. The panel is a control
surface, never a weaker path: there is no new way to reach team state.

## Mutations are opt-in, and why

`config.allowMutations` defaults to **false**. With it off the endpoint is
read-only and every control renders disabled with the switch named in its
tooltip — a control that silently does nothing would be worse than no control.

It is off by default because this endpoint is a loopback HTTP route registered
directly on `webServer`, outside the app's own auth middleware (the app's routes
answer 401 to an unauthenticated caller; this one answers 200). Enabling
mutations therefore makes team actions reachable by any local process. Turn it
on deliberately:

```yaml
- id: team-progress
  config:
    allowMutations: true
```

## Cautions the panel does not hide

- **A stale revision is refused.** Two people closing the same task is a 409 with
  `TEAM_TASK_CONFLICT`, not a silent overwrite. The panel re-reads and shows the
  domain code.
- **Wake resumes an inactive member.** That is the point of the button, but it is
  a real turn start, not a notification.
- **Interrupt keeps the inbox.** A stopped member still has its queued messages,
  same as `interrupt_agent`.
- **The panel cannot rename or remove a teammate.** No such API exists in
  `@deepseek-ai/dsh-experimental-agent-team@0.2.1-rc.5` — see
  `<dsh-checkout>/docs/teammate-lifecycle.md`.

## Verification

`node test/verify-host.mjs` pins the action surface: mutations are 403 unless the
profile opts in, a disabled switch reaches no domain method, `wake` sends one
text block as the Lead, `interrupt` echoes the status it saw, `complete` is a
compare-and-set on the displayed revision, and every refusal is a 400/403/404/409
that performs nothing.

`node test/verify.mjs` pins the controls: one wake per teammate and none for the
lead, stop only for running members, complete only where a claim carries a
revision, every control disabled (not hidden) with the switch named when
mutations are off, the receipt line, and the domain code on failure.

---

# 0.4.0 — one card per team

A profile can host several unrelated teams at once. 0.3.0 rendered one flat
table, so a Lead looking at `builder-check` could not tell which team it belonged
to, and the global headline averaged unrelated work together.

## What changed

- **One card per lead-session.** Each card carries the team's own label, its own
  `n/m tasks · x/y members · k stalled` counts, its own attention list, its own
  roster, and its own goal.
- **The label is the goal objective** when the team has an armed goal, because
  that is the only durable statement of what a team is *for*. Without one the
  handle is `team <id>` — never a guess derived from task text.
- **The headline and the bar stay global**: they answer "how much of everything is
  done", and the sidebar glyph keeps using them.
- **`teams` is a new payload field**; the flat `roster`/`goal`/`attention` remain,
  so a consumer that predates 0.4.0 keeps working and the panel degrades to the
  old flat render if `teams` is absent or empty.

## Action corrections in the same release

| Before | Now | Why |
|---|---|---|
| `Complete` on an already-completed claim | `Reopen` | the old button called a transition that was already applied, so it always failed |
| `Nudge` on every idle member | only claimed or stalled members | a control that cannot change anything is noise on a 27-row board |

## Verification

`node test/verify-host.mjs` pins two leads with unrelated boards producing two
`teams` entries, each carrying only its own roster and counts, own labels from
the goal objective, a `team <id>` fallback, and one `goals.get` per lead (the
aggregate goal is the union, not a second read).

`node test/verify.mjs` pins two cards with disjoint member sets, per-card counts
that disagree with each other, both labels on screen, `Reopen` instead of
`Complete` on a completed claim, and no wake control on an idle unclaimed member.

---

# Post-0.4.0 — the defect-log parser under-counted, and the live run

Found by reading the **live** payload on `http://127.0.0.1:64182` (desktop
profile, `allowMutations: true`) and comparing it against the real document.

## The defect log lost 4 of its 32 rows

`scanDefectTables` ended a table at the first line that was not a `|` row. The
live log writes **some rows of one table separated by blank lines**, so a strict
markdown reading of it produced:

| | rows | fixed | in flight | open | other |
|---|---|---|---|---|---|
| before | 28 | 15 | 6 | 3 | 4 |
| after | **32** | **18** | **6** | **4** | **4** |
| hand count of the file | 32 | 18 | 6 | 4 | 4 |

A count that disagrees with the document is the same defect class the panel
exists to expose, so blank lines are now transparent **while the next non-blank
line is still a data row**. A heading, separator, a new header or prose still ends
the table, so a genuinely new table is never absorbed. Regression test **N6** in
`test/verify-host.mjs` covers a blank-line split, a two-blank-line split, and a
following table after a heading.

## Status vocabulary — four states, and the document owns them

The panel recognises exactly four states and counts anything else as
`unclassified`:

| state | bucket | meaning |
|---|---|---|
| `fixed` | `fixed` | PR merged. A trailing reference (`**fixed #222** — …`) does not change the state. |
| `in flight` | `inFlight` | PR open. **A row that is partly done is `in flight`.** |
| `open` | `open` | no fix yet |
| `closed as superseded` | `superseded` | the work was real and will not land as itself |

A status cell carries prose after the state, so the cell is cut at the first
punctuation that ends the phrase — which is what lets
`**closed as superseded, not merged**` resolve to `superseded` rather than falling
through to `unclassified`, and what keeps `fixed #257 @ 52de5b4 (merge commit …)`
reading as `fixed`.

**The document gets the vocabulary; the panel does not grow a bucket for every
phrasing.** Two phrasings had appeared outside the four states:

- `**partly fixed**` (row 24) → mapped to **`in flight`** in the ledger, because
  `has_incident()` still ignores `mode`. Mapping it to `fixed` would have
  overstated the row; a `partlyFixed` bucket would let one row's phrasing dictate
  a fifth column.
- `**rule added, not yet applied**` (rows 26/27) → already gone; both are
  `**fixed** #257 @ 52de5b4`.

**Still open in the ledger.** The vocabulary remap was drafted and then **dropped**:
the ledger's owner rebased the document and merged the duplicate rows themselves,
which superseded the draft. But that rebase merged *duplicate rows*, not the
vocabulary remap — **row 24 still reads `**partly fixed**`**, and the legend still
lists three states. So the ledger parses as **37 rows — fixed 30 / in flight 2 /
open 3 / superseded 1 / unclassified 1**, and the panel will show `unclassified 1`
the moment the view is pointed at it.

The one-line change still needed, in the document itself:

```diff
- | **partly fixed** — `has_incident()` ignores `mode` …
+ | **in flight** — `has_incident()` ignores `mode` …
```

With that row remapped the same document parses as `in flight 3 / unclassified 0`
at an unchanged total of 37 — one row reclassified, nothing gained or lost.

### A judgement call worth surfacing

The ledger also carries a five-row table headed `| # | Why ancestry could not be
established |`. It has no `Status` column, so the parser correctly excludes it from
"defects by status" — those rows are about *verification of ancestry*, not defect
status. If the ledger owner intends them to count, that table needs a status
column; the panel will not infer one.

## Live verification

| check | result |
|---|---|
| `roster.state` | `ok`, 30 members, 3 leads |
| stalled detection | **2 real finds** — `fixture-capturer`, `test-hardener`, both `inactive` while holding an `in_progress` task |
| `goal.state` | `ok`, real objective, rounds + phase |
| `defects.state` | `unavailable`, `counts: null`, reason `ENOENT … live-run-defects-2026-10-30.md` |
| `degraded` | `{ any: false, reasons: [] }` — a missing defect file does **not** degrade the board, by design |

The defects view is `unavailable` for one reason only: the configured file was not
present in the checkout that profile reads. It exists on 3+ branches of the
document's own repository (newest: 32 rows). To light the view up, either check
one of those branches out, or point the config at a materialised copy:

```yaml
- id: team-progress
  config:
    allowMutations: true
    defectLogs:
      - /absolute/path/to/live-run-defects-2026-10-30.md
```

## The action surface is ON — owner decision, 2026-10-30

`config.allowMutations` defaults to **false** in code, so any fresh profile is
read-only until it opts in. The **desktop** profile opts in
(`allowMutations: true`, [profiles/desktop/cordis.patch.yml](<~/.dsh/profiles/desktop/cordis.patch.yml>),
row 538, kept outside the setup-manager managed block so a generate cannot revert
it either way).

It was briefly switched off during this review, then restored by the owner on the
record after the blast radius was stated. **The trade, stated plainly:**

`/api/team-progress/rpc` is registered directly on `webServer`, outside the app's
auth middleware. It answers **200 to a plain `curl` with no cookie, no header and
no token** — verified on the live port. With the flag on, `act` can, as the Lead:

| action | effect |
|---|---|
| `task` | complete / reopen / release / claim a shared board task |
| `wake` | resume an inactive member (`sendMessage`) |
| `interrupt` | stop a running agent |

So **any local process — any agent in a session, any script, any tool on this
machine — can drive the shared board through this route.** The owner accepted
that on a single-user loopback workstation, deliberately. The sibling
`mcp-manager` / `setup-manager` / `cc-commands` routes share the posture; that is
an observation, not a justification.

**To go read-only:** set the flag to `false`. `act` answers `403`
(`TEAM_PROGRESS_ACTIONS_DISABLED`), the Wake / Stop / Complete controls render
disabled and name the switch, and every view, count and the read path keep
working.

### How "the gate is open" was verified without moving the board

A deliberate power needs evidence that does not exercise it. Four probes, none of
which mutated anything:

| probe | response | what it proves |
|---|---|---|
| `args: {}` | `400` `leadId is required` | the `403` gate is gone — this failed at the gate when the flag was off |
| bogus `leadId` | `400` `that lead session is not live` | reaches membership resolution, still no domain call |
| real lead, no `expectedRevision` | `400` `expectedRevision is required: it is the compare-and-set guard` | reaches the CAS guard, the last check before `updateTask` |
| real lead, `expectedRevision: 103` on a task at revision 3 | `409` **`TEAM_TASK_STALE_REVISION`** | **refused on domain grounds**, not on the flag |

The last probe is chosen so it *cannot* apply: a revision that cannot match is
refused by compare-and-set by construction. `task-12` was re-read afterwards —
owner, revision `3`, status `in_progress` all unchanged, and the board totals
identical (`total 38`, `inProgress 8`, `completed 24`) before and after. `wake`
and `interrupt` were not sent at all.

## Post-0.4.0 — Wake/Nudge answered 500, because `sendMessage` requires a caller signal

Reported 2026-10-30 from the live board: the Wake button did nothing. Complete,
Reopen and Stop worked. The panel had been naming the failure the whole time — a red
notice at the very top of the panel, above the attention list, which sits outside a
screenshot cropped to the first team card.

Reproduced without moving the board, by targeting the lead itself (a self-message is
refused by the domain before anything is journaled):

| call | before (observed) | after (offline harness) |
|---|---|---|
| `act` → `{action:'wake', leadId: <live lead>, target: 'lead'}` | `500` `{"code":"ERR_INVALID_ARG_TYPE","error":"signals[0] is not of type AbortSignal."}` | `409` `TEAM_SELF_MESSAGE` |

**Cause.** `SendTeamMessageRequest.signal` is required
(`<dsh-checkout>/packages/experimental/agent-team/src/types.ts`,
lines 181-185) and the mailbox's own first move is
`AbortSignal.any([request.signal, this.lifecycle.signal])`
(`mailbox.ts`, line 59). `AbortSignal.any` rejects `undefined`, so a request that
omitted `signal` threw before the message was enqueued. `performAct` sent
`{ target, content }` only. `UpdateTeamTaskRequest` and `interrupt` carry no signal
at all, which is why exactly one of the four buttons was broken. The model's own
`send_message` tool passes `exec.signal` for the same field
(`tool-agent-team/src/index.ts`, line 227).

**Fix.** `PANEL_SIGNAL` (`lib/index.js`, line 1083) is passed on the wake path
(`lib/index.js`, line 1134). It never aborts on purpose: the HTTP request has already
answered by the time dispatch runs, the message is durable in the mailbox before
dispatch is attempted, and the domain composes the service lifecycle signal in
regardless.

**Why the suite was green.** `test/verify-host.mjs` stubbed `sendMessage` with
`Promise.resolve({ sent: true })` — a fake with no obligations, looser than the
domain it stands in for. The stub now calls `AbortSignal.any([request.signal])`
first, which is the real service's own first move, and the wake checks assert
`request.signal instanceof AbortSignal`. Both fail against the 0.4.0 code.

**Needs one host reload.** The host half is an ESM module inside the app process, and
`dsh-hmr` watches client bundles only. A running app keeps the old `apply()` until it
restarts, so the `after` column is what a restarted host answers, not something this
session could observe on the live panel.

## Reloading both halves without restarting the app

The host half is an ESM module inside the app process, so editing `lib/index.js`
does nothing on its own: `dsh-hmr` watches client bundles under its own `baseDir`
(the app bundle), never this package, and Node's ESM cache keeps the old module
namespace for a URL it has already imported.

`plugin_manager set_plugin` on `include:team-progress` — `enabled: false`, then
`enabled: true` — re-imports the module and rebuilds the client bundle from
`lib/client.js`. Verified 2026-10-30 on the running desktop app: the same `act`
probe answered `500 ERR_INVALID_ARG_TYPE` before the cycle and `409
TEAM_SELF_MESSAGE` after it, with no restart and no board movement.

Use it whenever a fix here has to land live. A plain file edit, or a
patch-file reconcile, is not enough.

## Post-0.4.0 — the legend sat on the bar, and the wake receipt overclaimed

Two follow-ups from the same board, both fixed without restarting:

- `.tp-legend` carried `margin-top: -4px`, which measured **2.5 CSS px** of ink
  between the bar and its caption at 2x — a collision, not a gap. It is `8px`
  now: the bar reads as a figure with a caption under it.
- `wake` returned `{ ok, action, target, message }` no matter what the domain
  said, so the panel printed `woke <name>` even for a mailbox that only *queued*
  the message. The host now reports `delivery: 'accepted' | 'queued' | null`
  (`deliveryStatusOf`) and the client words each case: `woke X`, `queued a
  message for X`, `message sent to X` when the domain gave no status at all.
  `null` is not treated as a wake.

Audited at the same time, with stale-revision and unknown-member probes that
cannot mutate: `complete`, `reopen` and `interrupt` all reach the domain and are
refused there on their own terms (`TEAM_TASK_STALE_REVISION`,
`TEAM_MEMBER_NOT_FOUND`). Only `wake` was broken in code — `Nudge` is the same
action with a different label, so it shares the one fix.

## Post-0.4.0 — scanning a 27-row roster (and the missing buttons)

Owner report from the live board: "why do some teammates have no nudge or wake?".
The gate was `stalled || hasClaim`, so a teammate holding nothing got no control at
all, and a *running* teammate holding nothing got only `Stop` — exactly the rows a
Lead most wants to poke. Every non-lead teammate is now addressable:

| row | before | now |
|---|---|---|
| stalled, holds a task | Wake (amber) | Wake (amber) |
| holds a task | Nudge | Nudge |
| running, holds nothing | Stop only | Nudge + Stop |
| idle, holds nothing | **nothing** | Nudge |

Urgency lives in the tone, not the presence. A claimless nudge also sends its own
message (`payload.message`) — the host's default nudge talks about an in-progress
task, which would have been a false statement about a teammate that has none.

Four layout defects fixed in the same pass, each measured on the live board:

- **The table was not a table.** Each row is its own grid and two tracks were
  `auto`, so a row without a STALLED badge put its task status ~150px left of its
  own header. Tracks are fixed now; header and body share one template.
- **Three buttons wrapped.** 152px could not hold Nudge + Stop + Complete, and the
  overflow button moved onto the *next row's* visual line — it read as though
  `builder-check` owned `run-auditor`'s controls. The actions track is 208px.
- **Status was a word per row.** It is a dot plus the word now: a filled green dot
  for running, an amber dot when stalled, a hollow ring at rest, dashed for
  unknown. Amber is reserved for the state that needs the Lead — `inactive` is a
  teammate's normal resting state and no longer shouts.
- **27 rows of history.** Rows are grouped: anything running, stalled or holding
  in-progress work stays; the rest folds behind one control that states the count
  (`show 22 idle`), never a silent truncation. The section still reports the full
  roster size, and the fold is per team.

Motion, and the rule it had to pass. 0.2.0 banned animation outright — "no implied
continuous advance" — because a bar creeping forward claims work the host never
reported. That rule is narrowed, not dropped: `@keyframes` exist only for `tp-beat`
on the status dot and the `live` marker, both of which repeat a state the host DID
report; the bar's segments still may not animate or transition, no keyframes may
touch geometry, and everything is behind `prefers-reduced-motion: no-preference`.
The style-rule checks were rewritten to pin exactly that.

The fold's open flag is module state (`IDLE_OPEN`, keyed per team), not
`React.useState`. The offline harness invokes each component with a reset hook
cursor, so a nested component-local `useState` can read the panel's slot and start
open — the first attempt rendered 10/10 rows in the test while the code was right.
The hook is kept only as the re-render trigger.

## Post-0.4.0 — the swarm, and a flash that only fires on a diff

The roster table answers "who is on what" one row at a time, which is the wrong
shape for the question a Lead asks first: **is anything alive, and is anything
stuck?** Under the bar there is now a swarm — one circle per agent across every
team:

| channel | encodes |
|---|---|
| shape | role — round is a teammate, a rounded square is the Lead |
| ring colour | the status the host reported (green running, red failed, grey at rest, dashed unknown) |
| fill | stalled, in the warning colour |
| two letters | the name, collapsed (`fact-verifier` → `FV`) |
| click | opens that agent's session |
| caption | `38 agents · 7 running · 2 stalled` — the counts it actually drew |

Verified on the live board 2026-10-30: 38 chips, 7 running, 2 stalled, 4 teams.

**The flash is the only new motion, and it is a receipt.** The poller compares each
new reading with the previous one (`diffMembers`, keyed `leadId|memberId`, over
status + stall + claim + claim status) and marks the members whose signal *moved*.
Those get `data-flash="1"` on the chip and on their roster row, which plays
`tp-flash` once. A member seen for the first time does not flash — there is nothing
to compare it to — and a steady board never flashes at all, so the panel cannot
look busy while nothing is happening. The test pins exactly that: one diff, one
flash, on the row and its chip, and none without a diff.

Both animations sit inside the same `prefers-reduced-motion: no-preference` gate as
`tp-beat`; the bar still may not animate. That rule survives; it just no longer
means "no motion anywhere".

## Post-0.4.0 — the chalkboard: the board drawn as a board

Owner ask: "create a green board like a class to show the tasks and assignment,
with handwritten style, and show progress toward the goal."

**Host.** `readLead` already reads the tasks; the payload now carries a second
projection of that one read — `lanes` (`ready`, `inProgress`, `done`, `blocked`)
plus `laneCounts`. Same readiness rule as `boardOf`, same owner names, no extra
service call. Each lane is capped at 12 cards; `laneCounts` carries the true total
so a capped lane is visibly short rather than quietly short. Verified live: a
live team reports `ready 19 · in flight 3 · done 47 · blocked 0` and a card
reads `{id: task-1, subject: '<task subject>', owner: 'track-a-ci-goldens', status:
'completed', revision: 3}`.

**Client.** A chalkboard per team card, above the roster:

- dark green board, wooden frame, faint dust texture, `Chalkboard SE` → `Chalkboard`
  → `Bradley Hand` → `cursive`;
- four chalk lanes with counts, task subjects in chalk white, owners in chalk mint,
  `unassigned` in dilute italics;
- a chalk **progress ring** drawn from `completed / total` — and *no ring at all*
  when the host cannot report a total, because an empty ring reads as 0%;
- the goal line beside it: `round 2/20 · 35 of 66 tasks done · active`;
- `reopen` on any done card that carries a revision, wired to the same
  compare-and-set task action the roster uses;
- lanes reflow to 2 columns under 760px and 1 under 460px (the sidebar is narrow).

**Motion.** One new animation: `tp-chalk-in`, a 0.5s opacity reveal of the lanes when
the board mounts. It reveals a board, it does not advance one — still inside
`prefers-reduced-motion: no-preference`, still no keyframes on geometry, and the bar
is still forbidden from animating.

### "Why can't I reopen these teammates?"

Reopen is a **task** action, not a member action: `action: 'task', op: 'reopen'`
needs a `taskId` and its `expectedRevision`, and the panel only offers it on a row
that holds a claimed task. A teammate with no claim has no task to reopen, so the
control is absent rather than broken — the payload has nothing to send. And reopening
a task never resumes its owner: the task returns to `ready`, the agent stays
inactive until something wakes it. Wake/Nudge is the member action; Reopen is the
task action. The chalkboard now offers `reopen` on the done card, where the task is.

## Post-0.4.0 — the board becomes the surface, and the surface calms down

Owner ask, in one breath: "make it not hard or dense for the eye, without dropping
anything" and "let me run the work from here — assign, start, stop, move, broadcast".

**Host** gained three actions, all through the same authority path the model's tools
use (the Lead credential is resolved from the session, never from the request body):

| action | domain call | notes |
|---|---|---|
| `create` | `createTask(caller, {subject, description})` | subject required, ≤200 chars; returns the new id |
| `task` + `op: 'reassign'` | `updateTask(…, {action:'reassign', owner})` | lead-only by the domain itself; `owner: ''` unassigns |
| `broadcast` | `sendMessage` × every teammate | reports `sent / accepted / queued / failed[]`, never a single `ok` |

**Client** — every card is now a control surface, and every control carries the
revision the card was drawn at, so a card that moved under you is refused
(`TEAM_TASK_STALE_REVISION`) instead of overwriting somebody's work:

| where | control | sends |
|---|---|---|
| ready card | assign select | `task` `reassign` `owner` |
| in-flight card | `done` | `task` `complete` |
| in-flight card | `stop` | `task` `release` (back to ready) |
| done card | `reopen` | `task` `reopen` |
| ready lane `+` | task composer | `create` |
| board head | `message all N` | `broadcast` |

A card whose payload carries no `revision` shows no controls at all: there is
nothing to send as the compare-and-set guard, so the panel does not offer a button
that must fail.

**The calm pass**, without removing a single feature:

- a lane previews **4 cards** and states the true count beside it; `show N more`
  opens that lane. The board stays a board, not a dump.
- attention is printed **once**: a card only repeats the list when its own differs
  from the aggregate above it (`sameAttention`, comparing the words).
- thinner wooden frame (3px), larger body text (11.5→13.5 on titles), higher line
  height, softer lane accents, and per-card controls at 55% opacity that come to
  full on hover or keyboard focus.
- one composer at a time per team; opening `+` or `message all` closes the other.

Verified live 2026-10-30 after a hot reload: `create` with a blank subject → 400,
`broadcast` with a blank message → 400, `reassign` reaches the domain and is refused
on a stale revision, `state` → 200 with 71 tasks / 49 done. Not exercised live: an
actual create, an actual reassign, and an actual broadcast, because each would land
real work on the board — they are covered by the offline suite instead (548 checks).

**Not built, deliberately: images and attachments.** `sendMessage` carries content
blocks, so an image is *representable*, but the RPC has a 64 KB body cap and no
upload path — the honest next step is a host-side attachment store plus a
`content: [{type:'image', …}]` variant, not a base64 blob squeezed through a JSON
route.

## Post-0.4.0 — release, the strongest teardown the domain actually has

Owner report: "hiding does not delete them or free resources." Correct, and the
distinction is now three explicit controls instead of one vague one:

| control | what it really does | frees |
|---|---|---|
| `⊘` hide | panel-local filter, persisted in the alias store | nothing; the row still counts against `maxMembers` |
| `⏏` release | `roster.stopTeammates` (drains the continuable child) **and** `workspaceRegistry.archiveSession({stopActivity:true})`, then persists `hidden` | the agent's runtime, its turns/jobs/schedules, and its chat in the app |
| Stop | `interrupt` | the current turn only |
| remove | **no domain op** | nothing — it does not exist |

`release` is deliberately not called delete. Agent Teams keeps the roster entry:
the name is the address peers message, and there is no removal event in the journal.
So release reports `slotFreed: false` in its own receipt rather than implying the
cap moved. The confirm dialog says the same thing before the click lands.

Two APIs make release real, both from the installed runtime:
`TeamRoster.stopTeammates(root, ids)` → `ctx.subagents.drainContinuableChildren`,
and `WorkspaceRegistry.archiveSession(id, {stopActivity:true})`, which cancels the
session's turns, subagent descendants, jobs and schedules through the same paths
the user's own stop actions use.

Alias, purpose and hidden all live in one record per member
(`~/.dsh/team-progress/aliases.json`, key `leadId|memberId`), so a rename note, a
purpose and a hide survive a reload together. `aliasFile` is configurable and the
offline suite points it at a temp file, so tests never write the owner's real one.

# 0.5.0 — the Overview question, and how much session hangs off one Lead

## What changed

Two fields, both answering a question the counts above could not.

**`waitingOnYou`** — per card and folded at the top of the payload:

| field | meaning |
|---|---|
| `stalled` | teammates holding an `in_progress` task while `inactive`/`failed`. Someone has to answer or unblock them. |
| `unassigned` | `ready` tasks with no owner. Someone has to hand them out. |
| `idle` | `inactive` teammates with no claim, **only reported when ready work exists**. Context for `unassigned`, deliberately excluded from `total`: one ready task with three idle teammates is one thing to do. |
| `total` | `stalled + unassigned`. `null` when either half could not be read. |

**`lineage`** — per card, three counts kept apart:

| field | meaning |
|---|---|
| `forks` | children with `isSeeded: true` and no `origin` — a session forked from this one, so it starts with an inherited event prefix. |
| `subagents` | children with `origin: 'subagent'` — delegated work that reports back. |
| `other` | children carrying neither marker. Counted, never guessed at. |
| `branches` | the sum. |

`branches` is the cheap honest signal that one conversation is carrying more than a
conversation. It is not a session-tree UI and deliberately does not become one.

## Why `waitingOnYou` is not a rename of `stalled`

`stalled` was already the one state the shipped Agent Team UI cannot show. It is
still a proper subset of `waitingOnYou.when` — the new half is *unowned ready
work*, which is the Lead's other failure mode: a teammate went idle and the board
still has things nobody holds. Neither number can be read off the other.

## Cost, and why lineage is one read per Lead

`sessionQuery.filterSessions([{ kind: 'parent', values: [leadId] }])` — one call
per lead, batched with `Promise.all` before the card map so the map stays
synchronous. Children are counted from the `SessionHeader` only: no titles, no
event reads, no `readSession`. A `41 MB` session answers this in the filter, not
in a replay.

Two honest degradations, both tested:

- a profile with no `sessionQuery` reports `lineage.state: 'unavailable'` with a
  reason, and **does not degrade the board** — lineage is a secondary view, and a
  missing store must not make a readable task list look broken.
- a store that throws is isolated per lead, so one unreadable lineage never costs
  the other cards their rows.

## Verification (2026-11-01)

`test/verify-host.mjs` adds `waitingOnYou` and `lineage` to the exact-key `SHAPE`
contract — an accidental extra field still fails the suite. Six new checks, all
green: `total === stalled + unassigned`, the stalled teammate is counted, the fork
and subagent children are counted apart, `branches` is their sum, exactly one store
read per lead, and that read is the parent filter for that lead.

`test/verify.mjs` stays green unchanged: a payload with no `waitingOnYou` still
renders, because the chip falls back to the old `N stalled` line.

The panel now prints `N need you` (warn colour, tooltip breaks it into stalled /
unowned / idle) ahead of `N stalled`, and `N branches` in tertiary colour with the
forks/subagents breakdown in its tooltip.
