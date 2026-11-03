// dsh-team-progress — client half (browser plane).
//
// FOUR VIEWS of the team's live work, top to bottom, in the owner's priority
// order. Two entry points:
//
//   sidebar.panellist  id "team-progress", order 40 — a compact glyph whose bar
//                      segments are proportional to COUNTS, with the same
//                      integers in its native title (the sidebar renders only a
//                      16-18px glyph inside `span.panelGlyph[aria-hidden]`,
//                      dsh-client-ui-sidebar/lib/client.js:220-229).
//   main               key "team-progress" — the panel:
//
//     STALLED  task task-5   owner beta is inactive     ← 4. attention, FIRST
//     BLOCKED  task task-6   waiting on task-4
//
//     3/6 tasks · 2/3 members                            ← headline
//     ▓▓▓▓▓▓▓░░░▓
//
//     MEMBERS                                            ← 1. who is on what
//       member     status      claimed task              task status
//       lead       running     task task-6               pending
//       alpha      running     task task-4               in progress
//       beta       inactive    task task-5               in progress  STALLED
//
//     DEFECTS    10 fixed · 5 in flight · 4 open (19)     ← 2. tracked defects
//       #2   Repo→app mapping is dead code.
//       #17  False CRITICAL.
//
//     GOAL       round 7/256 · active · armed             ← 3. goal progress
//       Extend dsh-team-progress with the four views
//
// ORDER IS DELIBERATE. View 4 (blocked/stalled) sits at the TOP even though it
// is the owner's fourth priority, because it is the only view that means "act
// now". The other three follow in priority order.
//
// WHAT THIS PANEL DOES NOT RENDER
//
//   * No percentage, no ETA, no elapsed time, no rate, and no animation or
//     transition, so nothing implies continuous forward motion between samples.
//   * No model column and no member `description`: the description is fixed at
//     spawn and drifts as work moves. The CLAIMED TASK is the durable truth, so
//     that is the column. (0.2.0 deliberately re-introduces per-member rows —
//     the owner asked for them — but joins them on the board, not on prose.)
//   * No zero for an unreadable source. Every view renders
//     `unavailable: <reason>` instead, because a 0 that means "could not read" is
//     the defect class this team spent the day fixing.
//   * No degraded banner: a partial board collapses into one short suffix on the
//     headline, and each view states its own availability in place.
//
// HONESTY RULES:
//   * Every printed number is a COUNT of durable state — board tasks, claimed
//     owners, goal rounds, defect-log rows.
//   * `no claimed task` is an ABSENCE, rendered as words, never as a 0.
//   * `no goal` is NOT the same as an unreadable goal, and neither is 0 rounds.
//   * `null` stall never prints as "not stalled": it prints nothing.
//
// Module format: DSH client bundles are NOT ES modules. The page loads this file
// and it registers itself through window.__ModuleLoader__.load({ id, factory });
// the factory returns module.exports carrying apply for cordis.
//
// Styling: --dsw-alias-* / --dsw-radius-* / --ds-* design tokens only, which the
// app redefines on `body` and `body[data-ds-dark-theme]`, so light and dark work
// with no theme code here.
window.__ModuleLoader__.load({
	id: "dsh-team-progress",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		// ===================== tokens ==========================================
		var CSS = [
			".tp-root{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;text-align:left;max-width:680px}",

			/* 1. the one line */
			".tp-line{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;font-variant-numeric:tabular-nums}",
			".tp-line-count{font-size:16px;font-weight:650;letter-spacing:-0.012em;white-space:nowrap}",
			".tp-line-sep{color:var(--dsw-alias-label-tertiary)}",
			".tp-line-members{color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".tp-line-note{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}",
			".tp-line[data-loading='1']{color:var(--dsw-alias-label-secondary);font-variant-numeric:normal}",
			".tp-error{color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}",

			/* 2. the honest bar */
			".tp-bar{display:flex;gap:2px;width:100%;height:8px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-border-l1);border:1px solid var(--dsw-alias-border-l2);box-sizing:border-box}",
			".tp-seg{flex-basis:0;min-width:0;height:100%;border-radius:2px}",
			".tp-seg[data-seg='completed']{background:var(--dsw-alias-state-success-primary)}",
			".tp-seg[data-seg='in_progress']{background:var(--dsw-alias-state-business-primary)}",
			".tp-seg[data-seg='pending_ready']{background:var(--dsw-alias-label-tertiary)}",
			".tp-seg[data-seg='blocked']{background:var(--dsw-alias-state-warn-primary)}",
			/* The bar is a figure, not a rule: it needs air below it before the
			   legend reads as a caption rather than as part of the bar. The old
			   -4px pull-up measured 2.5 CSS px of ink gap at 2x, which reads as a
			   collision. */
			".tp-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:8px}",
			".tp-legend span{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}",
			".tp-swatch{width:7px;height:7px;border-radius:2px;flex:none}",

			/* 3. attention */
			".tp-attention{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}",
			".tp-att-item{display:grid;grid-template-columns:64px minmax(0,1fr) auto;align-items:baseline;gap:8px;font-size:12px;min-height:20px}",
			".tp-att-kind{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}",
			".tp-att-kind[data-kind='stalled']{color:var(--dsw-alias-state-warn-primary)}",
			".tp-att-kind[data-kind='blocked']{color:var(--dsw-alias-label-secondary)}",
			".tp-att-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tp-att-detail{color:var(--dsw-alias-label-tertiary);font-size:11.5px;white-space:nowrap}",
			".tp-att-more{font-size:11.5px;color:var(--dsw-alias-label-tertiary);padding-left:72px}",

			/* sections */
			".tp-section{display:flex;flex-direction:column;gap:5px}",
			".tp-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
			".tp-title{font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}",
			".tp-figure{font-size:12px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
			".tp-figure-muted{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
			".tp-unavailable{font-size:12px;color:var(--dsw-alias-label-tertiary);font-style:italic;word-break:break-word}",
			".tp-none{font-size:12px;color:var(--dsw-alias-label-tertiary)}",

			/* members */
			".tp-members{display:flex;flex-direction:column;gap:1px}",
			/* Fixed tracks, not `auto`: every row is its own grid, so an `auto`
			   track sized from that row's own badge and button text and the
			   columns drifted row to row — measured on the live board, the task
			   status of a row without a STALLED badge sat ~150px left of its own
			   header. The header row uses this same class, so one template keeps
			   head and body in a single alignment. */
			".tp-mrow{display:grid;grid-template-columns:minmax(104px,1.15fr) 76px minmax(0,2.3fr) 96px 56px 208px;align-items:center;gap:10px;min-height:26px;font-size:13px;padding:1px 6px;border-radius:6px}",
			".tp-mrow:hover{background:var(--dsw-alias-bg-l2)}",
			".tp-mrow[data-role='lead'] .tp-mname{font-weight:650}",
			".tp-mhead{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}",
			".tp-mname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
			".tp-namecell{display:flex;align-items:center;gap:4px;min-width:0}",
			/* Status is a dot plus a word: the dot is readable in one glance down a
			   27-row roster, the word stays because a colour is not a label. Amber
			   is reserved for the state that needs the Lead — `inactive` is the
			   normal resting state of a teammate, so it no longer shouts. */
			".tp-status{display:inline-flex;align-items:center;gap:6px;min-width:0}",
			".tp-dot{width:7px;height:7px;border-radius:50%;flex:none;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:transparent}",
			".tp-dot[data-status='running']{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".tp-dot[data-status='failed']{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".tp-dot[data-status='unknown']{border-style:dashed}",
			".tp-dot[data-stalled='1']{background:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
			".tp-mstatus{color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".tp-mstatus[data-stalled='1']{color:var(--dsw-alias-state-warn-primary)}",
			".tp-mstatus[data-status='failed']{color:var(--dsw-alias-state-error-primary)}",
			/* Motion is a state encoding, never an advance: it fires only on rows
			   the host reports as running, and stops entirely for a reader who
			   asked for reduced motion. Nothing here animates a count or a bar. */
			"@media (prefers-reduced-motion: no-preference){@keyframes tp-beat{0%,100%{opacity:.4}50%{opacity:1}}.tp-dot[data-status='running']{animation:tp-beat 2s ease-in-out infinite}.tp-dot[data-stalled='1']{animation:tp-beat 1.4s ease-in-out infinite}.tp-live-dot{animation:tp-beat 2.4s ease-in-out infinite}/* A flash is a one-shot receipt for a diff the host actually reported: it fires only when a reading differs from the previous one, and it never repeats while the state sits still. */@keyframes tp-flash{0%{box-shadow:0 0 0 3px var(--dsw-alias-state-warn-primary)}100%{box-shadow:0 0 0 3px transparent}}.tp-chip[data-flash='1']{animation:tp-flash 1.1s ease-out 1}.tp-mrow[data-flash='1']{animation:tp-flash 1.1s ease-out 1}}",
			".tp-live{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}",
			".tp-live-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}",
			".tp-idle-toggle{appearance:none;font:inherit;font-size:11.5px;line-height:1.6;padding:2px 10px;border-radius:999px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);align-self:flex-start;margin:3px 0 0 6px}",
			".tp-idle-toggle:hover{color:var(--dsw-alias-label-primary);border-style:solid}",
			".tp-members-head{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;flex-wrap:wrap}",
			".tp-spawn-tools{display:flex;flex-direction:column;gap:6px;align-items:flex-end}",
			".tp-spawn-form{display:flex;gap:6px;flex-wrap:wrap}",
			".tp-spawn-input{font:inherit;font-size:11.5px;padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-primary);outline:none;min-width:150px}",
			".tp-spawn-input:focus{border-color:var(--dsw-alias-label-tertiary)}",
			".tp-retire{appearance:none;font:inherit;font-size:11px;line-height:1;padding:1px 5px;border-radius:5px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-tertiary);border:1px solid transparent;opacity:0;transition:opacity .12s ease}",
			".tp-mrow:hover .tp-retire,.tp-retire:focus{opacity:1;border-color:var(--dsw-alias-border-l2)}",
			".tp-retire:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			/* The swarm: one circle per agent, shape = role, ring = state. It exists
			   because a 27-row table cannot be read at a glance and the panel had
			   a wall of empty width beside it. */
			".tp-swarm-wrap{display:flex;flex-direction:column;gap:7px}",
			".tp-swarm-cap{font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}",
			".tp-swarm{display:flex;flex-wrap:wrap;gap:6px}",
			".tp-chip{appearance:none;font:inherit;font-size:10.5px;font-weight:700;letter-spacing:.02em;width:27px;height:27px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;box-sizing:border-box;background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2)}",
			".tp-chip[data-role='lead']{border-radius:8px;color:var(--dsw-alias-label-primary)}",
			".tp-chip[data-status='running']{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
			".tp-chip[data-status='failed']{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".tp-chip[data-stalled='1']{background:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-inverse,#fff)}",
			".tp-chip:hover{border-style:solid;background:var(--dsw-alias-bg-l1)}",
			/* ---- the chalkboard: the board as a board ----
			   Calmer rules for the second pass: a thinner frame, fewer dashes, larger
			   type, and colour spent only where it means something (lane accent, done,
			   stalled). The count stays in the lane head; the cards are a preview. */
			".tp-chalk{position:relative;border-radius:14px;padding:18px 20px 20px;border:3px solid #7a5230;box-sizing:border-box;box-shadow:inset 0 0 80px rgba(0,0,0,.40),0 8px 20px rgba(0,0,0,.18);background:radial-gradient(120% 90% at 18% -10%,rgba(255,255,255,.07),transparent 55%),linear-gradient(160deg,#20402e 0%,#1b3627 55%,#182f22 100%);color:#e9f2e9;font-family:'Chalkboard SE','Chalkboard','Bradley Hand','Comic Sans MS','Segoe Print',cursive}",
			".tp-chalk-head{display:flex;align-items:center;gap:16px;margin-bottom:16px;position:relative;z-index:1}",
			".tp-chalk-fig{display:flex;align-items:center;gap:12px;flex:none}",
			".tp-chalk-pct{font-size:18px;line-height:1;color:#f4eaa8}",
			".tp-chalk-meta{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}",
			".tp-chalk-title{font-size:13.5px;line-height:1.3;color:#f4eaa8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tp-chalk-sub{font-size:11px;line-height:1.4;color:rgba(233,242,233,.66);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tp-chalk-tools{flex:none}",
			".tp-chalk-composer{margin:0 0 14px;position:relative;z-index:1}",
			".tp-chalk-input{width:100%;box-sizing:border-box;font:inherit;font-size:11.5px;color:#eaf3ea;background:rgba(0,0,0,.22);border:1px solid rgba(234,243,234,.28);border-radius:8px;padding:6px 9px;outline:none}",
			".tp-chalk-input::placeholder{color:rgba(234,243,234,.42)}",
			".tp-chalk-input:focus{border-color:rgba(244,234,168,.7)}",
			".tp-chalk-lanes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px;position:relative;z-index:1}",
			".tp-chalk-lane{display:flex;flex-direction:column;gap:10px;min-width:0}",
			".tp-chalk-lane-head{display:flex;align-items:center;gap:6px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:rgba(244,234,168,.9);padding-bottom:5px;border-bottom:1px solid rgba(244,234,168,.22)}",
			".tp-chalk-lane-count{margin-left:auto;color:rgba(233,242,233,.62);font-variant-numeric:tabular-nums;letter-spacing:0}",
			".tp-chalk-card{font-size:11.5px;line-height:1.45;color:#eef6ee;padding:2px 0 2px 10px;border-left:2px solid rgba(234,246,234,.16)}",
			".tp-chalk-card[data-lane='inProgress']{border-left-color:rgba(126,196,255,.55)}",
			".tp-chalk-card[data-lane='done']{border-left-color:rgba(140,220,160,.4);color:rgba(238,246,238,.74)}",
			".tp-chalk-card[data-lane='blocked']{border-left-color:rgba(255,150,140,.5)}",
			".tp-chalk-subject{overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}",
			".tp-chalk-open{appearance:none;font:inherit;background:none;border:none;padding:0;margin:0;text-align:left;cursor:pointer;color:inherit}",
			".tp-chalk-open:hover{text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}",
			".tp-chalk-open.tp-chalk-owner:hover{color:#c8f0d8}",
			".tp-chalk-foot{display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap}",
			".tp-chalk-owner{font-size:10.5px;color:#9fe0c0}",
			".tp-chalk-owner[data-empty='1']{color:rgba(233,242,233,.38);font-style:italic}",
			".tp-chalk-acts{display:inline-flex;align-items:center;gap:4px;margin-left:auto;opacity:.55;transition:opacity .15s ease}",
			".tp-chalk-card:hover .tp-chalk-acts,.tp-chalk-card:focus-within .tp-chalk-acts{opacity:1}",
			".tp-chalk-empty{font-size:11px;color:rgba(233,242,233,.32)}",
			".tp-chalk-more{align-self:flex-start;appearance:none;font:inherit;font-size:10.5px;padding:0;border:none;background:none;cursor:pointer;color:rgba(244,234,168,.75)}",
			".tp-chalk-more:hover{color:#fff}",
			".tp-chalk-act{appearance:none;font:inherit;font-size:10px;padding:1px 7px;border-radius:6px;cursor:pointer;background:transparent;color:rgba(244,234,168,.9);border:1px solid rgba(244,234,168,.3)}",
			".tp-chalk-act:hover:not(:disabled){color:#fff;border-color:rgba(244,234,168,.7)}",
			".tp-chalk-act:disabled{opacity:.4;cursor:default}",
			".tp-chalk-select{font:inherit;font-size:10px;max-width:104px;padding:1px 4px;border-radius:6px;background:rgba(0,0,0,.28);color:#dcefdc;border:1px solid rgba(234,243,234,.24)}",
			"@container (max-width: 760px){.tp-chalk-lanes{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}}",
			"@media (prefers-reduced-motion: no-preference){@keyframes tp-chalk-in{0%{opacity:0}100%{opacity:1}}.tp-chalk-lanes{animation:tp-chalk-in .5s ease-out 1}}",
			".tp-swarm-wrap{display:flex;flex-direction:column;gap:7px}",
			".tp-swarm-cap{font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}",
			".tp-swarm{display:flex;flex-wrap:wrap;gap:6px}",
			".tp-chip{appearance:none;font:inherit;font-size:10.5px;font-weight:700;letter-spacing:.02em;width:27px;height:27px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;box-sizing:border-box;background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2)}",
			".tp-chip[data-role='lead']{border-radius:8px;color:var(--dsw-alias-label-primary)}",
			".tp-chip[data-status='running']{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
			".tp-chip[data-status='failed']{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".tp-chip[data-stalled='1']{background:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-inverse,#fff)}",
			".tp-chip:hover{border-style:solid;background:var(--dsw-alias-bg-l1)}",
			/* ---- the chalkboard: the board as a board ---- */
			".tp-chalk{position:relative;border-radius:14px;padding:14px 16px 16px;box-shadow:inset 0 0 70px rgba(0,0,0,.5),0 8px 20px rgba(0,0,0,.22);border:6px solid #7a5230;box-sizing:border-box;background:radial-gradient(120% 90% at 18% -10%,rgba(255,255,255,.10),transparent 55%),radial-gradient(90% 70% at 92% 108%,rgba(255,255,255,.06),transparent 60%),linear-gradient(158deg,#22432f 0%,#1b3627 55%,#152c20 100%);color:#eaf3ea;font-family:'Chalkboard SE','Chalkboard','Bradley Hand','Comic Sans MS','Segoe Print',cursive}",
			".tp-chalk::after{content:'';position:absolute;inset:0;border-radius:10px;pointer-events:none;background-image:radial-gradient(rgba(255,255,255,.05) 1px,transparent 1px);background-size:3px 3px;opacity:.5}",
			".tp-chalk-head{display:flex;align-items:center;gap:14px;margin-bottom:12px;position:relative;z-index:1}",
			".tp-chalk-fig{display:flex;align-items:center;gap:10px;flex:none}",
			".tp-chalk-pct{font-size:19px;line-height:1;color:#f4eaa8;text-shadow:0 0 6px rgba(244,234,168,.35)}",
			".tp-chalk-meta{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".tp-chalk-title{font-size:12.5px;color:#f4eaa8;letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tp-chalk-sub{font-size:10.5px;color:rgba(234,243,234,.72);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tp-chalk-lanes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;position:relative;z-index:1}",
			".tp-chalk-lane{display:flex;flex-direction:column;gap:7px;min-width:0}",
			".tp-chalk-lane-head{display:flex;align-items:baseline;gap:6px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#f4eaa8;border-bottom:1px dashed rgba(244,234,168,.35);padding-bottom:3px}",
			".tp-chalk-lane-count{margin-left:auto;color:rgba(234,243,234,.8);font-variant-numeric:tabular-nums}",
			".tp-chalk-card{font-size:11px;line-height:1.35;color:#eef6ee;padding:0 0 0 8px;border-left:1px dashed rgba(234,246,234,.22)}",
			".tp-chalk-card[data-lane='inProgress']{border-left-color:rgba(120,200,255,.5)}",
			".tp-chalk-card[data-lane='done']{border-left-color:rgba(140,220,160,.45);color:rgba(238,246,238,.8)}",
			".tp-chalk-card[data-lane='blocked']{border-left-color:rgba(255,150,140,.55)}",
			".tp-chalk-owner{display:block;font-size:10px;color:#9fe0c0;margin-top:1px}",
			".tp-chalk-owner[data-empty='1']{color:rgba(234,243,234,.4);font-style:italic}",
			".tp-chalk-empty{font-size:10.5px;color:rgba(234,243,234,.38);font-style:italic}",
			".tp-chalk-more{font-size:10px;color:rgba(244,234,168,.75)}",
			".tp-chalk-act{appearance:none;font:inherit;font-size:10px;margin-left:6px;padding:0 5px;border-radius:4px;cursor:pointer;background:transparent;color:rgba(244,234,168,.85);border:1px dashed rgba(244,234,168,.45)}",
			".tp-chalk-act:hover{color:#fff;border-style:solid}",
			"@container (max-width: 760px){.tp-chalk-lanes{grid-template-columns:repeat(2,minmax(0,1fr))}}",
			"@media (prefers-reduced-motion: no-preference){@keyframes tp-chalk-in{0%{opacity:0}100%{opacity:1}}.tp-chalk-lanes{animation:tp-chalk-in .5s ease-out 1}}",
			".tp-mclaim{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tp-mclaim[data-empty='1']{color:var(--dsw-alias-label-tertiary);font-style:italic}",
			".tp-mtask{color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".tp-badge{font-size:9.5px;font-weight:700;letter-spacing:.05em;padding:1px 5px;border-radius:3px;white-space:nowrap;background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-inverse,#fff)}",
			".tp-badge-spacer{padding:0}",

			/* defects */
			".tp-open{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}",
			".tp-orow{display:grid;grid-template-columns:38px minmax(0,1fr);align-items:baseline;gap:8px;font-size:12px;min-height:20px}",
			".tp-oref{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".tp-otext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",

			/* goal */
			".tp-goal{display:flex;flex-direction:column;gap:2px}",
			".tp-goal-line{font-variant-numeric:tabular-nums;font-size:12px}",
			".tp-goal-phase{font-weight:650}",
			".tp-goal-phase[data-phase='blocked']{color:var(--dsw-alias-state-error-primary)}",
			".tp-goal-phase[data-phase='complete']{color:var(--dsw-alias-state-success-primary)}",
			".tp-goal-phase[data-phase='paused']{color:var(--dsw-alias-state-warn-primary)}",
			".tp-goal-objective{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tp-goal-sep{color:var(--dsw-alias-label-tertiary)}",

			"@container (max-width: 720px){.tp-mrow{grid-template-columns:minmax(88px,1fr) 60px minmax(0,1.6fr) 52px 168px}.tp-mcolumn-task{display:none}}",
			"@container (max-width: 460px){.tp-att-item{grid-template-columns:56px minmax(0,1fr)}.tp-att-detail{display:none}}",
			/* ---- v0.3: the action surface ---- */
			".tp-shell{height:100%;min-height:0;display:flex;flex-direction:column}",
			".tp-scroll{flex:1;min-height:0;overflow-y:auto;padding:24px 30px 56px;box-sizing:border-box}",
			".tp-root{max-width:1040px;gap:18px;font-size:13px}",
			".tp-actions{display:flex;align-items:center;gap:5px;justify-content:flex-end;flex-wrap:nowrap}",
			".tp-mhead-actions{text-align:right}",
			".tp-act{appearance:none;font:inherit;font-size:11.5px;line-height:1.6;padding:1px 9px;border-radius:999px;cursor:pointer;white-space:nowrap;background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2)}",
			".tp-act:hover:not(:disabled){background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary)}",
			".tp-act[data-tone='primary']{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
			".tp-act[data-tone='danger']{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".tp-act:disabled{opacity:.45;cursor:default}",
			".tp-link{appearance:none;background:none;border:none;padding:0;margin:0;font:inherit;color:inherit;cursor:pointer;text-align:left;text-decoration:underline;text-decoration-color:var(--dsw-alias-border-l2);text-underline-offset:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tp-link:hover{text-decoration-color:currentColor}",
			".tp-notice{position:sticky;top:-1px;z-index:3;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-l1);box-shadow:0 6px 12px rgba(0,0,0,.12)}",
			".tp-notice[data-notice='ok']{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}",
			".tp-notice[data-notice='error']{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			/* ---- v0.4: one card per team ---- */
			".tp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-l1)}",
			".tp-card-head{display:flex;align-items:baseline;gap:12px;justify-content:space-between;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:8px}",
			".tp-card-title{font-size:13.5px;font-weight:650;letter-spacing:-0.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
			".tp-card-meta{display:flex;align-items:baseline;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}",
			".tp-card-stalled{color:var(--dsw-alias-state-warn-primary);font-weight:600}",
			".tp-dormant{display:flex;flex-direction:column;gap:10px;margin-top:4px}",
			".tp-dormant-toggle{appearance:none;font:inherit;font-size:12px;padding:3px 10px;border-radius:999px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);align-self:flex-start}",
			".tp-dormant-toggle:hover{color:var(--dsw-alias-label-primary);border-style:solid}",
		].join("\n");

		var el = React.createElement;

		// Last-resort reporter: a client half that fails before it can render
		// anything is otherwise invisible (no devtools, no server-side log).
		function fatal(where, error) {
			try {
				var message = "team-progress: " + where + " failed — " + String((error && error.message) || error);
				console.error("[team-progress] " + message, error);
				var node = document.createElement("div");
				node.setAttribute("data-plugin", "team-progress-error");
				node.textContent = message;
				node.style.cssText =
					"position:fixed;left:16px;bottom:16px;z-index:99999;max-width:min(560px,90vw);padding:10px 12px;" +
					"border-radius:8px;border:1px solid #c9333f;background:#2a0f12;color:#ffd7db;" +
					"font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;pointer-events:auto";
				document.body.appendChild(node);
			} catch (ignored) {
				/* nothing further we can do */
			}
		}

		// ===================== shims ===========================================
		function makeStyles(ns) {
			return {
				insert: function (css) {
					var node = document.createElement("style");
					node.setAttribute("data-plugin", ns);
					node.textContent = css;
					document.head.appendChild(node);
					return function () {
						node.remove();
					};
				},
			};
		}

		// Host half registers POST /api/team-progress/rpc and answers { ok, ... }.
		function makeHost() {
			return {
				call: function (method, args) {
					return fetch("/api/team-progress/rpc", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ method: method, args: args === undefined ? null : args }),
					})
						.then(function (response) {
							return response.json().catch(function () {
								return { ok: false, error: "bad json response (HTTP " + response.status + ")" };
							});
						})
						.catch(function (error) {
							return { ok: false, error: String((error && error.message) || error) };
						});
				},
				// One mutation, as the Lead. The host refuses when the profile has
				// not opted in (`actions.enabled`), so the buttons are honest.
				act: function (payload) {
					return this.call("act", payload);
				},
			};
		}

		// ===================== one shared poller ===============================
		// Both entry points read the same snapshot: a single 5s poll, started by
		// the first subscriber and stopped when the last one unmounts.
		var POLL_MS = 5000;
		var host = makeHost();
		var store = {
			snapshot: null,
			error: null,
			loading: false,
			inflight: false,
			timer: null,
			listeners: [],
			// Which action is in flight (its key), and the outcome of the last one.
			posting: null,
			notice: null,
			// Members whose observable state moved since the previous read, keyed
			// `leadId|memberId`. A flash draws only where a diff proved a change.
			changed: Object.create(null),
		};

		/** Run one action, then re-read the board so the panel cannot lie about it. */
		function post(key, payload) {
			store.posting = key;
			store.notice = null;
			notify();
			return host.act(payload).then(function (response) {
				store.posting = null;
				if (!response || response.ok === false) {
					var code = response && response.code ? " (" + response.code + ")" : "";
					store.notice = { kind: "error", text: String((response && response.error) || "the action failed") + code };
				} else {
					store.notice = { kind: "ok", text: noticeOf(payload, response) };
				}
				notify();
				return refresh();
			});
		}

		/** A short, factual receipt. Never a claim the host did not confirm. */
		function noticeOf(payload, response) {
			if (payload.action === "wake") {
				// The host reports what it observed: `accepted` (the target took it
				// now) or `queued` (durable, not deliverable this instant). Anything
				// else is not confirmed as a wake.
				if (response && response.delivery === "queued") return "queued a message for " + payload.target;
				if (response && response.delivery === "accepted") return "woke " + payload.target;
				return "message sent to " + payload.target;
			}
			if (payload.action === "interrupt") {
				return "interrupted " + payload.target + (response.previousStatus ? " (was " + response.previousStatus + ")" : "");
			}
			if (payload.action === "task") {
				if (payload.op === "reassign") {
					return (payload.owner ? "assigned " : "unassigned ") + payload.taskId;
				}
				return payload.op + " · " + payload.taskId;
			}
			if (payload.action === "create") {
				return "created " + String((response && response.taskId) || "a task");
			}
			if (payload.action === "broadcast") {
				var sent = response && isCount(response.sent) ? response.sent : 0;
				var accepted = response && isCount(response.accepted) ? response.accepted : 0;
				var queued = response && isCount(response.queued) ? response.queued : 0;
				var failed = response && Array.isArray(response.failed) ? response.failed.length : 0;
				var line = "sent to " + String(sent) + " (" + String(accepted) + " accepted";
				if (queued > 0) line += ", " + String(queued) + " queued";
				if (failed > 0) line += ", " + String(failed) + " failed";
				return line + ")";
			}
			return "done";
		}

		function notify() {
			// Snapshot the listener list: a listener may unmount (and unsubscribe)
			// while this loop runs.
			var listeners = store.listeners.slice();
			for (var i = 0; i < listeners.length; i += 1) {
				try {
					listeners[i](store);
				} catch (error) {
					console.error("[team-progress] listener failed", error);
				}
			}
		}

		function refresh() {
			if (store.inflight) return Promise.resolve(null);
			store.inflight = true;
			store.loading = true;
			return host.call("state", null).then(function (response) {
				store.inflight = false;
				store.loading = false;
				if (!response || response.ok === false) {
					store.error = (response && response.error) || "Could not read the team summary";
				} else {
					store.error = null;
					store.changed = diffMembers(store.snapshot, response);
					store.snapshot = response;
				}
				notify();
				return response;
			});
		}

		function subscribe(listener) {
			store.listeners.push(listener);
			if (store.timer === null) {
				refresh();
				store.timer = setInterval(refresh, POLL_MS);
			}
			return function () {
				var index = store.listeners.indexOf(listener);
				if (index >= 0) store.listeners.splice(index, 1);
				if (store.listeners.length === 0 && store.timer !== null) {
					clearInterval(store.timer);
					store.timer = null;
				}
			};
		}

		function useStoreSnapshot() {
			var stateHook = React.useState({
				snapshot: store.snapshot,
				error: store.error,
				loading: store.loading,
				posting: store.posting,
				notice: store.notice,
			});
			var setLocal = stateHook[1];
			React.useEffect(function () {
				function sync() {
					setLocal({
						snapshot: store.snapshot,
						error: store.error,
						loading: store.loading,
						posting: store.posting,
						notice: store.notice,
					});
				}
				return subscribe(sync);
			}, []);
			return stateHook[0];
		}

		// ===================== pure view helpers ===============================
		var MAX_ATTENTION = 3;

		function isCount(value) {
			return typeof value === "number" && isFinite(value);
		}

		function text(value) {
			return typeof value === "string" ? value : "";
		}

		/** "6/6 tasks", or an explicit absence when the board could not be read. */
		function tasksPart(summary) {
			if (!summary || !isCount(summary.total)) return "task count unavailable";
			var completed = isCount(summary.completed) ? summary.completed : 0;
			return String(completed) + "/" + String(summary.total) + " tasks";
		}

		/** "3 members", or "2/3 members" when a roster row is not running. */
		function membersPart(summary) {
			var members = summary && summary.members;
			if (!members || !isCount(members.total) || members.total === 0) return null;
			if (isCount(members.live) && members.live < members.total) {
				return String(members.live) + "/" + String(members.total) + " members";
			}
			return String(members.total) + " members";
		}

		/**
		 * One short suffix instead of a degraded banner. Only the BOARD and TEAM
		 * read feeds this: a missing defect log is stated by the defects view in
		 * place, so it never makes a healthy board look like an incident.
		 */
		function suffixOf(snapshot) {
			var degraded = snapshot && snapshot.degraded;
			if (!degraded || degraded.any !== true) return null;
			var reasons = Array.isArray(degraded.reasons) ? degraded.reasons.join(" ") : "";
			if (/task board/.test(reasons)) {
				var summary = snapshot.summary || {};
				return isCount(summary.total) ? "part of the board unreadable" : "board unreadable";
			}
			if (/roster|live member status|durable team record/.test(reasons)) return "member status unavailable";
			if (/agent registry|live lead list/.test(reasons)) return "team state unavailable";
			return "partial data";
		}

		/** The bar's segments, derived from the summary's real counts. */
		function segmentsOf(summary) {
			return [
				{ key: "completed", label: "completed", count: summary.completed },
				{ key: "in_progress", label: "in progress", count: summary.inProgress },
				{ key: "pending_ready", label: "ready", count: summary.pendingReady },
				{ key: "blocked", label: "blocked", count: summary.blocked },
			];
		}

		var SEGMENT_COLOR = {
			completed: "var(--dsw-alias-state-success-primary)",
			in_progress: "var(--dsw-alias-state-business-primary)",
			pending_ready: "var(--dsw-alias-label-tertiary)",
			blocked: "var(--dsw-alias-state-warn-primary)",
		};

		// ===================== pieces ==========================================
		function SegmentedBar(props) {
			var summary = props.summary;
			// No counts, or nothing on the board: no bar at all. An empty bar would
			// read as "0% done" for a board whose size is simply unknown.
			if (!summary || !isCount(summary.total) || summary.total <= 0) return null;

			var segments = segmentsOf(summary);
			var drawn = [];
			var legend = [];
			for (var i = 0; i < segments.length; i += 1) {
				var segment = segments[i];
				if (!isCount(segment.count) || segment.count <= 0) continue;
				drawn.push(
					el("div", {
						key: segment.key,
						className: "tp-seg",
						"data-seg": segment.key,
						"data-count": String(segment.count),
						style: { flexGrow: segment.count, background: SEGMENT_COLOR[segment.key] },
						title: segment.label + ": " + String(segment.count),
					}),
				);
				legend.push(
					el(
						"span",
						{ key: segment.key, "data-legend": segment.key },
						el("i", {
							className: "tp-swatch",
							style: { background: SEGMENT_COLOR[segment.key] },
						}),
						segment.label + " " + String(segment.count),
					),
				);
			}

			var label =
				String(summary.completed) +
				" of " +
				String(summary.total) +
				" tasks completed; " +
				String(summary.inProgress) +
				" in progress; " +
				String(summary.pendingReady) +
				" pending and ready; " +
				String(summary.blocked) +
				" blocked";

			return el(
				"div",
				{ "data-bar-block": "1" },
				el(
					"div",
					{ className: "tp-bar", role: "img", "aria-label": label, "data-static": "1", "data-total": String(summary.total) },
					drawn,
				),
				el("div", { className: "tp-legend" }, legend),
			);
		}

		/**
		 * At most three rows, stalled first (the host already sorts them that way),
		 * then a "+N more" count. Nothing at all when everything is on track — no
		 * "0 blocked" row and no empty-state grid.
		 */
		function AttentionList(props) {
			var items = Array.isArray(props.items) ? props.items : [];
			if (items.length === 0) return null;

			var shown = items.slice(0, MAX_ATTENTION);
			var more = items.length - shown.length;
			var rows = [];

			for (var i = 0; i < shown.length; i += 1) {
				var item = shown[i] || {};
				var kind = String(item.kind || "blocked");
				rows.push(
					el(
						"li",
						{ key: "att-" + String(i), className: "tp-att-item", "data-attention-item": kind, "data-kind": kind },
						el("span", { className: "tp-att-kind", "data-kind": kind }, kind),
						el("span", { className: "tp-att-label" }, String(item.label || "a task")),
						el("span", { className: "tp-att-detail" }, String(item.detail || "")),
					),
				);
			}
			if (more > 0) {
				rows.push(
					el(
						"li",
						{ key: "att-more", className: "tp-att-more", "data-attention-more": String(more) },
						"+" + String(more) + " more",
					),
				);
			}

			return el("ul", { className: "tp-attention", "data-attention": String(items.length) }, rows);
		}

		function SectionHead(props) {
			var parts = [
				el("span", { key: "title", className: "tp-title" }, props.title),
			];
			if (props.figure !== null && props.figure !== undefined) {
				parts.push(el("span", { key: "figure", className: "tp-figure", "data-figure": props.title }, props.figure));
			}
			if (props.note !== null && props.note !== undefined) {
				parts.push(el("span", { key: "note", className: "tp-figure-muted" }, props.note));
			}
			return el("div", { className: "tp-head" }, parts);
		}

		/**
		 * A view whose source could not be read. Words, never a number: this is the
		 * whole point of the panel's honesty contract.
		 */
		function Unavailable(props) {
			return el(
				"div",
				{ className: "tp-unavailable", "data-unavailable-for": props.view },
				"unavailable: " + (text(props.reason) || "reason unknown"),
			);
		}

		// ---- view 1: members ------------------------------------------------
		/**
		 * One small action control.
		 *
		 * `busy` disables the surface while any action is in flight: two clicks
		 * must not queue two wakes for the same member. Disabled is not hidden —
		 * a control the profile has not enabled is shown with its reason in the
		 * title, because a missing button looks like a bug.
		 */
		function ActionButton(props) {
			var disabled = props.busy === true || props.enabled !== true;
			return el(
				"button",
				{
					type: "button",
					className: "tp-act",
					"data-act": props.act,
					"data-tone": props.tone || "quiet",
					"data-busy": props.busy === true ? "1" : "0",
					disabled: disabled,
					title: props.enabled === true ? props.title : "team actions are disabled for this profile (config.allowMutations)",
					onClick: disabled
						? undefined
						: function (event) {
								event.stopPropagation();
								props.onClick();
						  },
				},
				props.label,
			);
		}

		/** A destructive action asks once, in the platform's own words. */
		function confirmed(question) {
			if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
			return window.confirm(question) === true;
		}

		function memberRow(row, index, view, onRetire, onRestore, isRetired) {
			var stalled = row && row.stalled === true;
			var hasClaim = row && typeof row.taskId === "string";
			var isLead = row && row.role === "lead";
			var name = text(row && row.name);
			var nameCell =
				!isLead && row && typeof row.id === "string" && typeof row.leadId === "string" && view && typeof view.onOpen === "function"
					? el(
							"button",
							{
								type: "button",
								className: "tp-mname tp-link",
								title: "open " + name + "\u2019s session",
								onClick: function (event) {
									event.stopPropagation();
									view.onOpen(row);
								},
							},
							name,
					  )
					: el("span", { className: "tp-mname", title: name }, name);
			return el(
				"div",
				{
					key: "m-" + String(index),
					className: "tp-mrow",
					"data-member": name,
					"data-role": isLead ? "lead" : "teammate",
					"data-stalled": stalled ? "1" : "0",
					"data-flash": view && view.changed && view.changed[memberKey(row)] === true ? "1" : "0",
				},
				el(
					"span",
					{ className: "tp-namecell" },
					nameCell,
					!isLead && isRetired === true && typeof onRestore === "function"
					? el(
							"button",
							{
								type: "button",
								className: "tp-retire",
								"data-restore": name,
								title: "put " + name + " back on this panel",
								onClick: function (event) {
									event.stopPropagation();
									onRestore(name);
								},
							},
							"\u21ba",
						  )
					: !isLead && typeof onRetire === "function"
						? el(
								"button",
								{
									type: "button",
									className: "tp-retire",
									"data-retire": name,
									title: "hide " + name + " on this panel (the team roster still holds it)",
									onClick: function (event) {
										event.stopPropagation();
										onRetire(name);
									},
								},
								"\u00d7",
						  )
						: null,
				),
				el(
					"span",
					{ className: "tp-status" },
					el("i", {
						className: "tp-dot",
						"data-status": text(row && row.status) || "unknown",
						"data-stalled": stalled ? "1" : "0",
						"aria-hidden": "true",
					}),
					el(
						"span",
						{
							className: "tp-mstatus",
							"data-status": text(row && row.status),
							"data-stalled": stalled ? "1" : "0",
						},
						text(row && row.status) || "no status",
					),
				),
				el(
					"span",
					{
						className: "tp-mclaim",
						"data-claim": hasClaim ? text(row.taskId) : "",
						"data-empty": hasClaim ? "0" : "1",
						title: hasClaim ? text(row.taskSubject) || text(row.taskId) : "no claimed task",
					},
					hasClaim ? text(row.taskSubject) || text(row.taskId) : "no claimed task",
				),
				el(
					"span",
					{ className: "tp-mtask tp-mcolumn-task", "data-task-status": text(row && row.taskStatus) },
					hasClaim ? text(row.taskStatus) : "",
				),
				stalled
					? el("span", { className: "tp-badge", "data-stalled-badge": "1", title: "not running while owning an in-progress task" }, "STALLED")
					: el("span", { className: "tp-badge-spacer" }),
				el(
					"span",
					{ className: "tp-actions", "data-actions": isLead ? "none" : "1" },
					// Every teammate is addressable, not just the ones holding a task:
					// the Lead's question is usually "what are you doing?" and that
					// includes the agent that holds nothing. The tone, not the presence,
					// carries urgency — amber-primary for a stall, quiet otherwise.
					isLead
						? null
						: el(ActionButton, {
								act: "wake",
								label: stalled ? "Wake" : "Nudge",
								title: stalled
									? "message " + name + " so the stalled task resumes"
									: hasClaim
										? "send " + name + " a one-line status request"
										: "message " + name + " (no claimed task) so it reports where it stands",
								tone: stalled ? "primary" : "quiet",
								enabled: view && view.actions === true,
								busy: view && view.busy !== null && view.busy !== undefined,
								onClick: function () {
									// The default nudge talks about an in-progress task, which
									// a claimless teammate does not have; say the true thing.
									var payload = { action: "wake", leadId: row.leadId, target: name };
									if (!hasClaim && !stalled) {
										payload.message =
											"Status check from the team panel: you hold no claimed task. Reply with one line on where you stand, or claim a ready task if you are free.";
									}
									view.onAct(payload);
								},
						  }),
					!isLead && row && row.status === "running"
						? el(ActionButton, {
								act: "interrupt",
								label: "Stop",
								title: "interrupt " + name + "\u2019s current turn (its inbox is kept)",
								tone: "danger",
								enabled: view && view.actions === true,
								busy: view && view.busy !== null && view.busy !== undefined,
								onClick: function () {
									if (!confirmed("Interrupt " + name + "\u2019s current turn?")) return;
									view.onAct({ action: "interrupt", leadId: row.leadId, target: name });
								},
						  })
						: null,
					!isLead && hasClaim && row && Number.isInteger(row.taskRevision)
						? el(ActionButton, {
								act: row.taskStatus === "completed" ? "task-reopen" : "task-complete",
								label: row.taskStatus === "completed" ? "Reopen" : "Complete",
								title:
									row.taskStatus === "completed"
										? "reopen " + text(row.taskId) + " (revision " + String(row.taskRevision) + ")"
										: "mark " + text(row.taskId) + " completed (revision " + String(row.taskRevision) + ")",
								tone: "quiet",
								enabled: view && view.actions === true,
								busy: view && view.busy !== null && view.busy !== undefined,
								onClick: function () {
									var reopen = row.taskStatus === "completed";
									if (!confirmed(reopen ? "Reopen " + text(row.taskId) + "?" : "Mark " + text(row.taskId) + " completed?")) return;
									view.onAct({
										action: "task",
										op: reopen ? "reopen" : "complete",
										leadId: row.leadId,
										taskId: text(row.taskId),
										expectedRevision: row.taskRevision,
									});
								},
						  })
						: null,
				),
			);
		}

		// ===================== what changed ===================================
		// The panel re-reads the board every 5s. A flash is only honest when a
		// reading differs from the previous one, so the diff is computed at the one
		// place that owns both: the poller. A member that appears for the first time
		// does not flash — there was nothing to compare it to.

		/** The union roster the summary counts describe. */
		function rowsOfSnapshot(snapshot) {
			if (!snapshot || typeof snapshot !== "object") return [];
			var roster = snapshot.roster;
			if (roster && Array.isArray(roster.members) && roster.members.length > 0) return roster.members;
			var out = [];
			var teams = Array.isArray(snapshot.teams) ? snapshot.teams : [];
			for (var t = 0; t < teams.length; t += 1) {
				var members = teams[t] && teams[t].roster ? teams[t].roster.members : null;
				if (Array.isArray(members)) out = out.concat(members);
			}
			return out;
		}

		function memberKey(row) {
			if (!row) return "";
			return String(row.leadId || "") + "|" + String(row.id || row.name || "");
		}

		/** Everything about a member a glance can observe, as one comparable string. */
		function signalOf(row) {
			if (!row) return "";
			return [row.status, row.stalled === true ? "1" : "0", row.taskId || "", row.taskStatus || ""].join("|");
		}

		/** Keys whose signal moved between two readings; empty on the first read. */
		function diffMembers(previous, next) {
			var changed = Object.create(null);
			if (!previous || !next) return changed;
			var before = Object.create(null);
			var oldRows = rowsOfSnapshot(previous);
			for (var i = 0; i < oldRows.length; i += 1) before[memberKey(oldRows[i])] = signalOf(oldRows[i]);
			var rows = rowsOfSnapshot(next);
			for (var j = 0; j < rows.length; j += 1) {
				var key = memberKey(rows[j]);
				var was = before[key];
				if (was !== undefined && was !== signalOf(rows[j])) changed[key] = true;
			}
			return changed;
		}

		/** Same attention rows as the aggregate above? Compare the words, not the array. */
		function sameAttention(cardItems, topItems) {
			var card = Array.isArray(cardItems) ? cardItems : [];
			var top = Array.isArray(topItems) ? topItems : [];
			if (card.length === 0) return true;
			if (card.length !== top.length) return false;
			for (var i = 0; i < card.length; i += 1) {
				var a = card[i] || {};
				var b = top[i] || {};
				if (text(a.kind) !== text(b.kind) || text(a.label) !== text(b.label) || text(a.detail) !== text(b.detail)) return false;
			}
			return true;
		}

		/** Two letters that identify an agent inside a 27px circle. */
		function initialsOf(name) {
			var parts = String(name === undefined || name === null ? "" : name)
				.split(/[^A-Za-z0-9]+/)
				.filter(Boolean);
			if (parts.length === 0) return "?";
			if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
			return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
		}

		// ===================== the chalkboard ==================================
		/** Chalk percentage: only over a board whose size the host actually reported. */
		function percentOf(done, total) {
			if (!isCount(done) || !isCount(total) || total <= 0) return null;
			return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
		}

		/** One chalk-drawn progress ring. No ring at all when the ratio is unknown. */
		function ChalkRing(props) {
			var percent = props.percent;
			if (percent === null) return el("span", { className: "tp-chalk-pct" }, "—");
			var radius = 26;
			var circumference = 2 * Math.PI * radius;
			var filled = (circumference * percent) / 100;
			return el(
				"svg",
				{ width: 64, height: 64, viewBox: "0 0 64 64", role: "img", "aria-label": String(percent) + "% of tasks completed" },
				el("circle", { cx: 32, cy: 32, r: radius, fill: "none", stroke: "rgba(234,243,234,.22)", "stroke-width": 5 }),
				el("circle", {
					cx: 32,
					cy: 32,
					r: radius,
					fill: "none",
					stroke: "#f4eaa8",
					"stroke-width": 5,
					"stroke-linecap": "round",
					"stroke-dasharray": String(circumference),
					"stroke-dashoffset": String(circumference - filled),
					transform: "rotate(-90 32 32)",
					"data-ring": String(percent),
				}),
				el(
					"text",
					{
						x: 32,
						y: 36,
						"text-anchor": "middle",
						fill: "#f4eaa8",
						"font-size": 15,
						"font-family": "inherit",
					},
					String(percent) + "%",
				),
			);
		}

		var CHALK_LANES = [
			{ key: "ready", label: "ready", hint: "unclaimed work" },
			{ key: "inProgress", label: "in flight", hint: "someone is on it" },
			{ key: "done", label: "done", hint: "finished" },
			{ key: "blocked", label: "blocked", hint: "waiting on another card" },
		];

		// A lane shows a handful of cards and says how many it holds. The board is
		// the working surface, not a wall: the count is always true, the preview is
		// deliberately short, and one click opens the rest.
		var LANE_PREVIEW = 4;

		/** Which lanes the reader opened, and which composers are open. Keyed per
		 *  team so two boards do not move together. Module scope for the same reason
		 *  as IDLE_OPEN: it must survive a re-render without depending on hook slots. */
		var LANE_OPEN = Object.create(null);
		var BOARD_UI = Object.create(null);
		function boardUi(key) {
			if (BOARD_UI[key] === undefined) BOARD_UI[key] = { broadcast: false, compose: false };
			return BOARD_UI[key];
		}

		/** A chalk control. Disabled is shown, never hidden. */
		function chalkButton(label, title, onClick, opts) {
			var options = opts || {};
			return el(
				"button",
				{
					type: "button",
					className: "tp-chalk-act",
					"data-chalk-act": options.act || label,
					title: title || label,
					disabled: options.enabled === false,
					onClick: function (event) {
						event.stopPropagation();
						if (options.enabled === false) return;
						onClick();
					},
				},
				label,
			);
		}

		/**
		 * The board as a working surface: every control maps to one domain call the Lead
		 * is already allowed to make, and the card carries the revision it was drawn at,
		 * so a change made elsewhere is refused rather than silently overwritten.
		 */
		function ChalkCard(props) {
			var row = props.row || {};
			var lane = props.lane;
			var team = props.team || {};
			var view = props.view;
			var names = Array.isArray(props.members) ? props.members : [];
			var enabled = view && view.actions === true;
			var busy = Boolean(view && view.busy !== null && view.busy !== undefined);
			var dispatch = function (payload) {
				view.onAct(payload);
			};
			var taskPayload = function (op, extra) {
				var base = {
					action: "task",
					op: op,
					leadId: team.leadId,
					taskId: text(row.id),
					expectedRevision: row.revision,
				};
				return extra === undefined ? base : Object.assign(base, extra);
			};
			var controllable = Number.isInteger(row.revision) && enabled && !busy;
			var owner = row.owner ? text(row.owner) : "";
			// A card names its owner so the owner is one click away, not as decoration.
			var ownerRow = null;
			var memberRows = Array.isArray(props.memberRows) ? props.memberRows : [];
			for (var mi = 0; mi < memberRows.length; mi += 1) {
				if (memberRows[mi] && text(memberRows[mi].name) === owner) ownerRow = memberRows[mi];
			}
			var openOwner = function (event) {
				if (event && event.stopPropagation) event.stopPropagation();
				if (ownerRow && view && typeof view.onOpen === "function") view.onOpen(ownerRow);
			};

			// A card whose revision the payload did not report cannot be moved: there is
			// nothing to send as the compare-and-set guard, so it carries no controls
			// rather than a control that would always fail.
			var graded = Number.isInteger(row.revision);
			var acts = [];
			if (graded && (lane === "ready" || lane === "inProgress")) {
				acts.push(
					el(
						"select",
						{
							key: "assign",
							className: "tp-chalk-select",
							"data-chalk-select": text(row.id),
							title: "assign " + text(row.id) + " to a teammate",
							value: "",
							disabled: !controllable,
							onChange: function (event) {
								event.stopPropagation();
								var name = event.target.value;
								if (name === "") return;
								dispatch(taskPayload("reassign", { owner: name }));
							},
						},
						[el("option", { key: "", value: "" }, owner === "" ? "assign\u2026" : owner)].concat(
							names.map(function (name) {
								return el("option", { key: name, value: name }, name);
							}),
						),
					),
				);
			}
			if (graded && lane === "inProgress") {
				acts.push(chalkButton("done", "mark " + text(row.id) + " completed", function () {
					if (!confirmed("Mark " + text(row.id) + " completed?")) return;
					dispatch(taskPayload("complete"));
				}, { act: "complete", enabled: controllable }));
				acts.push(chalkButton("stop", "release " + text(row.id) + " back to ready", function () {
					if (!confirmed("Release " + text(row.id) + " back to ready?")) return;
					dispatch(taskPayload("release"));
				}, { act: "release", enabled: controllable }));
			}
			if (graded && (lane === "ready" || lane === "blocked")) {
				acts.push(chalkButton("delete", "delete " + text(row.id), function () {
					if (!confirmed("Delete " + text(row.id) + "? A card that blocks another cannot be deleted.")) return;
					dispatch(taskPayload("delete"));
				}, { act: "delete", enabled: controllable }));
			}
			if (graded && lane === "done") {
				acts.push(chalkButton("reopen", "reopen " + text(row.id), function () {
					if (!confirmed("Reopen " + text(row.id) + "?")) return;
					dispatch(taskPayload("reopen"));
				}, { act: "reopen", enabled: controllable }));
			}

			return el(
				"div",
				{ className: "tp-chalk-card", "data-lane": lane, "data-task": text(row.id) },
				ownerRow
					? el(
							"button",
							{
								type: "button",
								className: "tp-chalk-subject tp-chalk-open",
								title: "open " + owner + "'s session",
								onClick: openOwner,
							},
							text(row.subject) || text(row.id),
					  )
					: el("div", { className: "tp-chalk-subject" }, text(row.subject) || text(row.id)),
				el(
					"div",
					{ className: "tp-chalk-foot" },
					ownerRow
						? el(
								"button",
								{
									type: "button",
									className: "tp-chalk-owner tp-chalk-open",
									"data-empty": "0",
									title: "open " + owner + "'s session",
									onClick: openOwner,
								},
								owner,
							  )
						: el("span", { className: "tp-chalk-owner", "data-empty": owner === "" ? "1" : "0" }, owner === "" ? "unassigned" : owner),
				acts.length === 0 ? null : el("span", { className: "tp-chalk-acts" }, acts),
				),
			);
		}

		function Chalkboard(props) {
			var team = props.team || {};
			var view = props.view;
			var lanes = team.lanes;
			if (!lanes || typeof lanes !== "object") return null;
			var key = text(team.leadId) || "team";
			var ui = boardUi(key);
			var bumpState = React.useState(0);
			var bump = bumpState[1];
			var redraw = function () {
				bump(function (v) {
					return v + 1;
				});
			};
			var counts = team.laneCounts || {};
			var summary = team.summary || {};
			var percent = percentOf(summary.completed, summary.total);
			var goal = team.goal && Array.isArray(team.goal.goals) ? team.goal.goals[0] : null;
			var rounds = goal && isCount(goal.roundsStarted) ? goal.roundsStarted : null;
			var cap = goal && isCount(goal.maxGoalRounds) ? goal.maxGoalRounds : null;
			var phase = goal && typeof goal.phase === "string" ? goal.phase : null;
			var names = (team.roster && Array.isArray(team.roster.members) ? team.roster.members : [])
				.map(function (member) {
					return member && member.role !== "lead" && typeof member.name === "string" ? member.name : null;
				})
				.filter(Boolean);
			var enabled = view && view.actions === true;

			var meta = [];
			if (rounds !== null || cap !== null) {
				meta.push("round " + (rounds === null ? "?" : String(rounds)) + (cap === null ? "" : "/" + String(cap)));
			}
			if (isCount(summary.completed) && isCount(summary.total)) {
				meta.push(String(summary.completed) + " of " + String(summary.total) + " tasks done");
			}
			if (phase !== null) meta.push(phase);

			return el(
				"div",
				{ className: "tp-chalk", "data-chalk": "1", "data-team": text(team.label) },
				el(
					"div",
					{ className: "tp-chalk-head" },
					el("div", { className: "tp-chalk-fig" }, el(ChalkRing, { percent: percent })),
					el(
						"div",
						{ className: "tp-chalk-meta" },
						el("div", { className: "tp-chalk-title" }, text(team.label) || "team"),
						el("div", { className: "tp-chalk-sub", "data-chalk-sub": "1" }, meta.join(" \u00b7 ")),
					),
					el(
						"div",
						{ className: "tp-chalk-tools" },
						chalkButton(
							ui.broadcast ? "close" : "message all " + String(names.length),
							"send one message to every teammate",
							function () {
								ui.broadcast = ui.broadcast !== true;
								redraw();
							},
							{ act: "broadcast-open", enabled: enabled && names.length > 0 },
						),
					),
				),
				ui.broadcast
					? el(
							"div",
							{ className: "tp-chalk-composer", "data-chalk-composer": "broadcast" },
							el("input", {
								className: "tp-chalk-input",
								type: "text",
								placeholder: "say one thing to all " + String(names.length) + " teammates\u2026",
								onKeyDown: function (event) {
									if (event.key !== "Enter") return;
									var message = String(event.target.value || "").trim();
									if (message === "") return;
									if (!confirmed("Send this to " + String(names.length) + " teammates?")) return;
									// Clear before the answer arrives: the field is a composer, not a log.
									// The receipt lands in the notice strip, and the board re-reads
									// immediately after the host answers.
									event.target.value = "";
									ui.broadcast = false;
									redraw();
									view.onAct({ action: "broadcast", leadId: team.leadId, message: message });
								},
							}),
						  )
					: null,
				el(
					"div",
					{ className: "tp-chalk-lanes" },
					CHALK_LANES.map(function (lane) {
						var rows = Array.isArray(lanes[lane.key]) ? lanes[lane.key] : [];
						var total = isCount(counts[lane.key]) ? counts[lane.key] : rows.length;
						var openKey = key + "|" + lane.key;
						var expanded = LANE_OPEN[openKey] === true;
						var shown = expanded ? rows : rows.slice(0, LANE_PREVIEW);
						var hidden = rows.length - shown.length;
						return el(
							"div",
							{ key: lane.key, className: "tp-chalk-lane", "data-chalk-lane": lane.key },
							el(
								"div",
								{ className: "tp-chalk-lane-head", title: lane.hint },
								lane.label,
								el("span", { className: "tp-chalk-lane-count" }, String(total)),
								lane.key === "ready"
									? chalkButton(
											ui.compose ? "\u00d7" : "+",
											"add a task to this team",
											function () {
												ui.compose = ui.compose !== true;
												redraw();
											},
											{ act: "compose", enabled: enabled },
									  )
									: null,
							),
							lane.key === "ready" && ui.compose
								? el("input", {
										className: "tp-chalk-input",
										type: "text",
										placeholder: "new task\u2026 then Enter",
										onKeyDown: function (event) {
											if (event.key !== "Enter") return;
											var subject = String(event.target.value || "").trim();
											if (subject === "") return;
											// Stays open on purpose: adding three tasks in a row should not
											// need three clicks on `+`. The lane opens with it, because a new
											// card lands at the end of a preview it would otherwise be behind.
											event.target.value = "";
											LANE_OPEN[key + "|ready"] = true;
											redraw();
											view.onAct({ action: "create", leadId: team.leadId, subject: subject });
										},
								  })
								: null,
							shown.length === 0
								? el("div", { className: "tp-chalk-empty" }, "\u2014")
								: shown.map(function (row, index) {
										return el(ChalkCard, {
											key: "card-" + String(index),
											row: row,
											lane: lane.key,
											team: team,
											view: view,
											members: names,
										});
								  }),
							hidden > 0
								? el(
										"button",
										{
											type: "button",
											className: "tp-chalk-more",
											"data-chalk-more": lane.key,
											onClick: function (event) {
												event.stopPropagation();
												LANE_OPEN[openKey] = true;
												redraw();
											},
										},
										"show " + String(hidden) + " more",
									  )
								: null,
						);
					}),
				),
			);
		}

		/**
		 * The swarm: one chip per agent, shape = role (round teammate, rounded-square
		 * lead), ring = the status the host reported, fill = stalled. Clicking opens
		 * that agent's session. It is the same information as the roster table, in a
		 * shape that can be read at a glance instead of row by row.
		 */
		function Constellation(props) {
			var members = Array.isArray(props.members) ? props.members : [];
			if (members.length === 0) return null;
			var changed = props.changed || {};
			var running = 0;
			var stalled = 0;
			for (var c = 0; c < members.length; c += 1) {
				if (members[c] && members[c].status === "running") running += 1;
				if (members[c] && members[c].stalled === true) stalled += 1;
			}
			var caption = String(members.length) + (members.length === 1 ? " agent" : " agents");
			if (running > 0) caption += " · " + String(running) + " running";
			if (stalled > 0) caption += " · " + String(stalled) + " stalled";
			return el(
				"div",
				{ className: "tp-swarm-wrap", "data-swarm": "1" },
				el("div", { className: "tp-swarm-cap" }, caption),
				el(
					"div",
					{ className: "tp-swarm", role: "list", "aria-label": caption },
					members.map(function (row, index) {
						var name = text(row && row.name);
						var status = text(row && row.status) || "unknown";
						var stalledRow = row && row.stalled === true;
						var label =
							name +
							" \u2014 " +
							(status || "no status") +
							(stalledRow ? " (stalled)" : "") +
							(row && row.taskSubject ? " \u00b7 " + text(row.taskSubject) : row && row.taskId ? " \u00b7 " + text(row.taskId) : "");
						return el(
							"button",
							{
								key: "chip-" + String(index),
								type: "button",
								role: "listitem",
								className: "tp-chip",
								"data-chip": name,
								"data-status": status,
								"data-stalled": stalledRow ? "1" : "0",
								"data-role": row && row.role === "lead" ? "lead" : "teammate",
								"data-flash": changed[memberKey(row)] === true ? "1" : "0",
								title: label,
								"aria-label": label,
								onClick: function (event) {
									event.stopPropagation();
									if (props.onOpen) props.onOpen(row);
								},
							},
							initialsOf(name),
						);
					}),
				),
			);
		}

		// Which rosters the reader has unfolded this session, keyed per team so two
		// teams open independently. Module scope, not a hook: it must survive a
		// re-render, and it must not depend on hook-slot position.
		var IDLE_OPEN = Object.create(null);
		// Panel-side agent management. `retire` hides a member on THIS panel for this
		// session — the team roster still holds it, and the label says so. Spawning is
		// a real domain call; retiring is not, because Agent Teams has no remove op.
		var MEMBER_UI = Object.create(null);
		var RETIRED = Object.create(null);
		function memberUi(key) {
			if (MEMBER_UI[key] === undefined) MEMBER_UI[key] = { spawn: false, showRetired: false };
			return MEMBER_UI[key];
		}

		function rowsKey(roster) {
			var members = roster && Array.isArray(roster.members) ? roster.members : [];
			var lead = members.find(function (row) {
				return row && row.role === "lead";
			});
			var id = lead && typeof lead.leadId === "string" ? lead.leadId : "";
			return id !== "" ? id : "roster-" + String(members.length);
		}

		function MembersView(props) {
			var roster = props.roster;
			if (!roster) return null;
			var view = props.view;

			var state = text(roster.state);
			var head = el(SectionHead, {
				title: "Members",
				figure: null,
				note: null,
			});

			if (state === "unavailable") {
				return el("div", { className: "tp-section", "data-roster": "1", "data-roster-state": "unavailable" }, head, el(Unavailable, { view: "roster", reason: roster.reason }));
			}

			// A roster of 27 is mostly teammates at rest; the rows that need the
			// Lead deserve the top of the list. Idle rows fold behind a toggle
			// (never hidden silently: the count is on the button, and the section
			// still reports the full roster size).
			//
			// The open flag is panel-owned rather than hook-owned on purpose: the
			// offline harness invokes each component with a shared hook cursor, so a
			// component-local `useState` can read another component's slot. The hook
			// here is only the re-render trigger; its value is never read.
			var bump = React.useState(0)[1];
			var rosterKey = rowsKey(roster);
			var idleOpen = IDLE_OPEN[rosterKey] === true;

			var allRows = Array.isArray(roster.members) ? roster.members : [];
			var uiKey = rowsKey(roster);
			var ui = memberUi(uiKey);
			var retired = RETIRED[uiKey] || (RETIRED[uiKey] = Object.create(null));
			var rows = allRows.filter(function (row) {
				return !(row && row.role !== "lead" && retired[text(row.name)] === true);
			});
			var retiredRows = allRows.filter(function (row) {
				return row && row.role !== "lead" && retired[text(row.name)] === true;
			});
			var stalledRows = rows.filter(function (row) {
				return row && row.stalled === true;
			}).length;
			head = el(SectionHead, {
				title: "Members",
				figure: isCount(rows.length) ? String(rows.length) : null,
				note: state === "partial" ? "live status unavailable" : stalledRows > 0 ? String(stalledRows) + " stalled" : null,
			});

			if (allRows.length === 0) {
				return el("div", { className: "tp-section", "data-roster": "1", "data-roster-state": state }, head, el("div", { className: "tp-none" }, "no members"));
			}

			// A row is "active" when something is happening or something is owed:
			// a running turn, a stall, or an in-progress claim. Everything else is
			// a teammate at rest, which is not a problem to fix.
			function active(row) {
				if (!row) return false;
				if (row.role === "lead") return true;
				if (row.status === "running") return true;
				if (row.stalled === true) return true;
				return row.taskStatus === "in_progress";
			}

			var shownRows = [];
			var restRows = [];
			for (var r = 0; r < rows.length; r += 1) {
				if (active(rows[r])) shownRows.push(rows[r]);
				else restRows.push(rows[r]);
			}
			// Only worth a control when it removes a real wall of rows.
			var collapses = restRows.length >= 4 && shownRows.length > 0;
			if (!collapses || idleOpen) shownRows = shownRows.concat(restRows);
			if (ui.showRetired === true) shownRows = shownRows.concat(retiredRows);

			var spawnTools = el(
				"div",
				{ className: "tp-spawn-tools" },
				el(
					"button",
					{
						type: "button",
						className: "tp-idle-toggle",
						"data-spawn-toggle": "1",
						title: "create a teammate through Agent Teams spawn_teammate",
						onClick: function (event) {
							event.stopPropagation();
							ui.spawn = ui.spawn !== true;
							bump(function (v) {
								return v + 1;
							});
						},
					},
					ui.spawn ? "\u00d7 new agent" : "+ new agent",
				),
				ui.spawn
					? el(
							"div",
							{ className: "tp-spawn-form", "data-spawn-form": "1" },
							el("input", {
								className: "tp-spawn-input",
								type: "text",
								placeholder: "name (lower-kebab-case)",
								"data-spawn-field": "name",
							}),
							el("input", {
								className: "tp-spawn-input",
								type: "text",
								placeholder: "first brief: what should it do?",
								"data-spawn-field": "prompt",
								onKeyDown: function (event) {
									if (event.key !== "Enter") return;
									var form = event.target.parentNode;
									var nameField = form.querySelector('[data-spawn-field="name"]');
									var name = String((nameField && nameField.value) || "").trim();
									var prompt = String(event.target.value || "").trim();
									if (name === "" || prompt === "") return;
									if (!confirmed("Create teammate \u0022" + name + "\u0022?")) return;
									event.target.value = "";
									view.onAct({ action: "spawn", leadId: roster.members[0] && roster.members[0].leadId, name: name, prompt: prompt });
								},
							}),
						  )
					: null,
			);

			var children = [
				el("div", { className: "tp-members-head" }, head, spawnTools),
				el(
					"div",
					{ className: "tp-members", "data-roster-rows": String(rows.length), "data-roster-shown": String(shownRows.length), "data-idle-hidden": collapses && !idleOpen ? String(restRows.length) : "0" },
					el(
						"div",
						{ key: "mh", className: "tp-mrow" },
						el("span", { className: "tp-mhead" }, "member"),
						el("span", { className: "tp-mhead" }, "status"),
						el("span", { className: "tp-mhead" }, "claimed task"),
						el("span", { className: "tp-mhead tp-mcolumn-task" }, "task status"),
						el("span", { className: "tp-badge-spacer" }),
						el("span", { className: "tp-mhead tp-mhead-actions" }, "actions"),
					),
					shownRows.map(function (row, index) {
						return memberRow(row, index, props.view, function (name) {
							retired[name] = true;
							bump(function (v) {
								return v + 1;
							});
						});
					}),
					retiredRows.length > 0
						? el(
								"button",
								{
									key: "retired",
									type: "button",
									className: "tp-idle-toggle",
									"data-retired-toggle": "1",
									title: "retired on this panel only; the team roster still holds them",
									onClick: function (event) {
										event.stopPropagation();
										ui.showRetired = ui.showRetired !== true;
										bump(function (v) {
											return v + 1;
										});
									},
								},
								(ui.showRetired ? "\u2212 hide " : "\uFF0B ") + String(retiredRows.length) + " retired (panel only)",
							  )
						: null,
					collapses && !idleOpen
						? el(
								"button",
								{
									key: "idle",
									type: "button",
									className: "tp-idle-toggle",
									"data-idle-toggle": "1",
									onClick: function (event) {
										event.stopPropagation();
										IDLE_OPEN[rosterKey] = true;
										bump(function (v) {
											return v + 1;
										});
									},
								},
								"show " + String(restRows.length) + " idle",
						  )
						: null,
				),
			];
			return el("div", { className: "tp-section", "data-roster": "1", "data-roster-state": state }, children);
		}

		// ---- view 2: defects ------------------------------------------------
		function DefectsView(props) {
			var defects = props.defects;
			if (!defects) return null;

			var state = text(defects.state);
			var head = el(SectionHead, { title: "Defects", figure: null, note: null });

			if (state === "unavailable") {
				return el("div", { className: "tp-section", "data-defects": "1", "data-defects-state": "unavailable" }, head, el(Unavailable, { view: "defects", reason: defects.reason }));
			}

			var counts = defects.counts || {};
			var pieces = [];
			// The four DOCUMENTED states. A phrasing outside them is counted as
			// `unclassified`, not squeezed into a nearby bucket — the fix belongs
			// in the document's vocabulary, not in a fifth column here.
			var buckets = [
				{ key: "fixed", label: "fixed" },
				{ key: "inFlight", label: "in flight" },
				{ key: "open", label: "open" },
				{ key: "superseded", label: "superseded" },
			];
			for (var i = 0; i < buckets.length; i += 1) {
				var bucket = buckets[i];
				if (!isCount(counts[bucket.key])) continue;
				// Zero is a real count, so it prints; only an unreadable source is silent.
				pieces.push(bucket.label + " " + String(counts[bucket.key]));
			}
			if (isCount(counts.other) && counts.other > 0) pieces.push("unclassified " + String(counts.other));

			var figure = pieces.join(" · ") + (isCount(counts.total) ? " (" + String(counts.total) + ")" : "");
			head = el(SectionHead, {
				title: "Defects",
				figure: figure,
				note: state === "partial" ? "partly unreadable" : null,
			});

			var open = Array.isArray(defects.open) ? defects.open : [];
			var children = [head];
			if (state === "partial" && text(defects.reason) !== "") {
				children.push(el("div", { className: "tp-none", "data-defects-note": "1" }, "unavailable: " + text(defects.reason)));
			}

			if (open.length > 0) {
				var list = open.map(function (row, index) {
					var ref = text(row && row.ref);
					var label = text(row && row.defect) || text(row && row.evidence) || "unnamed defect";
					return el(
						"li",
						{ key: "o-" + String(index), className: "tp-orow", "data-defect-row": ref },
						el("span", { className: "tp-oref" }, ref === "" ? "" : "#" + ref),
						el("span", { className: "tp-otext", title: label }, label),
					);
				});
				if (isCount(defects.openTruncated) && defects.openTruncated > 0) {
					list.push(
						el(
							"li",
							{ key: "o-more", className: "tp-orow", "data-defect-more": String(defects.openTruncated) },
							el("span", { className: "tp-oref" }),
							el("span", { className: "tp-otext" }, "+" + String(defects.openTruncated) + " more open"),
						),
					);
				}
				children.push(el("ul", { className: "tp-open", "data-defect-open": String(open.length) }, list));
			} else if (isCount(counts.open) && counts.open === 0) {
				children.push(el("div", { className: "tp-none", "data-defect-clear": "1" }, "no open defects"));
			}

			return el("div", { className: "tp-section", "data-defects": "1", "data-defects-state": state }, children);
		}

		// ---- view 3: goal ---------------------------------------------------
		function goalLine(goal, index) {
			var parts = [];
			// Rounds are only printed when both numbers are real. A missing cap
			// prints the count alone rather than "7/0" or "0/256".
			if (isCount(goal.roundsStarted) && isCount(goal.maxGoalRounds)) {
				parts.push(el("span", { key: "r", className: "tp-goal-phase", "data-goal-rounds": String(goal.roundsStarted) }, "round " + String(goal.roundsStarted) + "/" + String(goal.maxGoalRounds)));
			} else if (isCount(goal.roundsStarted)) {
				parts.push(el("span", { key: "r", className: "tp-goal-phase", "data-goal-rounds": String(goal.roundsStarted) }, "round " + String(goal.roundsStarted)));
			} else {
				parts.push(el("span", { key: "r", className: "tp-figure-muted" }, "rounds unavailable"));
			}
			if (text(goal.phase) !== "") {
				parts.push(el("span", { key: "s1", className: "tp-goal-sep" }, "·"));
				parts.push(el("span", { key: "p", className: "tp-goal-phase", "data-phase": text(goal.phase) }, text(goal.phase)));
			}
			if (text(goal.activation) !== "") {
				parts.push(el("span", { key: "s2", className: "tp-goal-sep" }, "·"));
				parts.push(el("span", { key: "a", className: "tp-figure-muted", "data-goal-activation": text(goal.activation) }, text(goal.activation)));
			}
			return el(
				"div",
				{ key: "g-" + String(index), className: "tp-goal", "data-goal-line": String(index) },
				el("div", { className: "tp-goal-line" }, parts),
				text(goal.objective) !== ""
					? el("div", { className: "tp-goal-objective", title: text(goal.objective) }, text(goal.objective))
					: null,
				text(goal.blockedReason) !== ""
					? el("div", { className: "tp-none", "data-goal-blocked-reason": "1" }, text(goal.blockedReason))
					: null,
			);
		}

		function GoalView(props) {
			var goal = props.goal;
			if (!goal) return null;

			var state = text(goal.state);
			var head = el(SectionHead, { title: "Goal", figure: null, note: null });

			if (state === "unavailable") {
				return el("div", { className: "tp-section", "data-goal": "1", "data-goal-state": "unavailable" }, head, el(Unavailable, { view: "goal", reason: goal.reason }));
			}
			if (state === "none") {
				// "no goal" — deliberately not "0 rounds" or "0/256".
				return el("div", { className: "tp-section", "data-goal": "1", "data-goal-state": "none" }, head, el("div", { className: "tp-none", "data-goal-none": "1" }, "no goal"));
			}

			var goals = Array.isArray(goal.goals) ? goal.goals : [];
			if (goals.length === 0) {
				return el("div", { className: "tp-section", "data-goal": "1", "data-goal-state": "none" }, head, el("div", { className: "tp-none", "data-goal-none": "1" }, "no goal"));
			}
			return el(
				"div",
				{ className: "tp-section", "data-goal": "1", "data-goal-state": state, "data-goal-count": String(goals.length) },
				head,
				goals.map(goalLine),
			);
		}

		// ===================== views ===========================================
		function TeamProgressView(props) {
			var snapshot = props.snapshot;
			var error = props.error;
			var view = props.view;

			if (!snapshot) {
				return el(
					"div",
					{ className: "tp-root" },
					error
						? el("div", { className: "tp-error", "data-error": "1" }, String(error))
						: el("div", { className: "tp-line", "data-loading": "1" }, "Reading the team board…"),
				);
			}

			var summary = snapshot.summary || {};
			var line = [
				el("span", { key: "tasks", className: "tp-line-count", "data-counts": tasksPart(summary) }, tasksPart(summary)),
			];

			var members = membersPart(summary);
			if (members !== null) {
				line.push(el("span", { key: "sep-1", className: "tp-line-sep" }, "·"));
				line.push(el("span", { key: "members", className: "tp-line-members", "data-members": members }, members));
			}

			var suffix = suffixOf(snapshot);
			if (suffix !== null) {
				line.push(el("span", { key: "sep-2", className: "tp-line-sep" }, "·"));
				line.push(el("span", { key: "suffix", className: "tp-line-note", "data-suffix": "1" }, suffix));
			}

			// Attention first: it is the only section that means "act now".
			return el(
				"div",
				{ className: "tp-root", "data-team-progress": "1" },
				view && view.notice
					? el(
							"div",
							{ className: "tp-notice", "data-notice": view.notice.kind },
							view.notice.text,
					  )
					: null,
				el(AttentionList, { items: snapshot.attention }),
				el(
					"div",
					{ className: "tp-line", "data-summary": "1" },
					line,
					// The dot is honest about one thing only: this panel re-reads the
					// board on a fixed interval. It is not a progress claim.
					el(
						"span",
						{ key: "live", className: "tp-live", "data-live": "1", title: "re-read every 5s while this panel is open" },
						el("i", { className: "tp-live-dot", "aria-hidden": "true" }),
						"live",
					),
				),
				el(SegmentedBar, { summary: summary }),
				el(Constellation, { members: rowsOfSnapshot(snapshot), changed: view && view.changed, onOpen: view && view.onOpen }),
				Array.isArray(snapshot.teams) && snapshot.teams.length > 0
					? [
							snapshot.teams
								.filter(function (team) {
									return !team.dormant;
								})
								.map(function (team, index) {
									return el(TeamCard, { key: "team-" + String(index), team: team, view: view, topAttention: snapshot.attention });
								}),
							el(DormantTeams, {
								topAttention: snapshot.attention,
								key: "dormant",
								teams: snapshot.teams.filter(function (team) {
									return team.dormant === true;
								}),
								view: view,
							}),
					  ]
					: [
							el(MembersView, { key: "m", roster: snapshot.roster, view: view }),
							el(GoalView, { key: "g", goal: snapshot.goal }),
					  ],
				el(DefectsView, { defects: snapshot.defects }),
			);
		}

		/**
		 * Teams with no tasks and nobody running: history, collapsed behind a count.
		 * They are still one card each when opened — nothing is deleted, only folded.
		 */
		function DormantTeams(props) {
			var hook = React.useState(false);
			var open = hook[0];
			var setOpen = hook[1];
			var teams = Array.isArray(props.teams) ? props.teams : [];
			if (teams.length === 0) return null;
			return el(
				"div",
				{ className: "tp-dormant", "data-dormant": String(teams.length) },
				el(
					"button",
					{
						type: "button",
						className: "tp-dormant-toggle",
						"aria-expanded": open === true ? "true" : "false",
						onClick: function () {
							setOpen(open !== true);
						},
					},
					(open === true ? "\u2212 hide " : "\uff0b ") + String(teams.length) + (teams.length === 1 ? " dormant team" : " dormant teams"),
				),
				open === true
					? teams.map(function (team, index) {
							return el(TeamCard, { key: "dormant-" + String(index), team: team, view: props.view, topAttention: props.topAttention });
					  })
					: null,
			);
		}

		/**
		 * One Team. The header carries the topic label and that team's own counts, so
		 * two unrelated teams never read as one big one.
		 */
		function TeamCard(props) {
			var team = props.team || {};
			var view = props.view;
			var summary = team.summary || {};
			var counts = tasksPart(summary);
			var members = membersPart(summary);
			var stalled = isCount(summary.stalled) ? summary.stalled : null;
			return el(
				"section",
				{ className: "tp-card", "data-team": text(team.label), "data-lead": text(team.leadId) },
				el(
					"div",
					{ className: "tp-card-head" },
					el("span", { className: "tp-card-title", title: text(team.label) }, text(team.label) || "team"),
					el(
						"span",
						{ className: "tp-card-meta" },
						el("span", { "data-team-counts": "1" }, counts),
						members === null ? null : el("span", { className: "tp-line-sep" }, "\u00b7"),
						members === null ? null : el("span", null, members),
						stalled === null || stalled === 0 ? null : el("span", { className: "tp-card-stalled" }, String(stalled) + " stalled"),
					),
				),
				// Attention already leads the panel. Repeating the same rows inside the
				// card is noise, not emphasis — so a card only restates it when its own
				// list differs from the aggregate above.
				sameAttention(team.attention, props.topAttention) ? null : el(AttentionList, { items: team.attention }),
				el(Chalkboard, { team: team, view: view }),
				el(MembersView, { roster: team.roster, view: view }),
				el(GoalView, { goal: team.goal }),
			);
		}

		// Full-width panel in the centre column (keyed slot; the sidebar button
		// dispatches the same key). `props.snapshot` is a test seam: the offline
		// harness mounts it with a fixture because the React shim runs no effects.
		/** Open one teammate's session in the app's own session view. */
		function openSession(row) {
			if (!row || typeof row.id !== "string" || typeof row.leadId !== "string") return;
			var workspace = svc.workspace;
			if (!workspace || typeof workspace.openSession !== "function") {
				fatal("open session", new Error("the uiWorkspace service is not available"));
				return;
			}
			try {
				workspace.openSession({
					parentSessionId: row.leadId,
					childSessionId: row.id,
					mode: "continuable",
				});
			} catch (error) {
				fatal("open session", error);
			}
		}

		function TeamProgressPanel(props) {
			var connected = useStoreSnapshot();
			var injected = props && props.snapshot !== undefined;
			var snapshot = injected ? props.snapshot : connected.snapshot;
			// `props.onAct` / `props.onOpen` are the offline test seams: the harness
			// mounts the panel with a fixture because the React shim runs no effects,
			// so the network path cannot be exercised there. In the app they are
			// absent and the real callers are used.
			var view = {
				actions: Boolean(snapshot && snapshot.actions && snapshot.actions.enabled === true),
				// Injected snapshots have no poller behind them, so the harness may
				// hand in the diff directly; the app path reads the poller's own.
				changed: injected ? props.changed || {} : connected.changed || {},
				busy: injected ? props.busy || null : connected.posting,
				notice: injected ? props.notice || null : connected.notice,
				onAct: typeof props.onAct === "function"
					? props.onAct
					: injected
						? function () {}
						: function (payload) {
								post(text(payload.action) + ":" + text(payload.target || payload.taskId), payload);
						  },
				onOpen: typeof props.onOpen === "function" ? props.onOpen : openSession,
			};
			return el(
				"div",
				{ className: "tp-shell" },
				el("div", { className: "tp-scroll" }, el(TeamProgressView, { snapshot: snapshot, error: props && props.error !== undefined ? props.error : connected.error, view: view })),
			);
		}

		// Sidebar glyph: a 4-segment bar whose widths are COUNTS, with the same
		// integers in the native tooltip (the sidebar renders only this glyph).
		// The tooltip also carries the two signals a glyph cannot draw: members
		// stalled and defects still open.
		function TeamGlyph(props) {
			var snapshot = props && props.snapshot;
			var size = (props && props.size) || 18;
			var summary = snapshot && snapshot.summary ? snapshot.summary : null;
			var counts = tasksPart(summary);
			var members = membersPart(summary);
			var extras = [];
			if (summary && isCount(summary.stalled) && summary.stalled > 0) {
				extras.push(String(summary.stalled) + " stalled");
			}
			var defects = snapshot && snapshot.defects;
			if (defects && defects.state === "ok" && defects.counts && isCount(defects.counts.open) && defects.counts.open > 0) {
				extras.push(String(defects.counts.open) + " open defects");
			}
			var label =
				"Team progress — " +
				counts +
				(members === null ? "" : " · " + members) +
				(extras.length > 0 ? " · " + extras.join(" · ") : "") +
				(suffixOf(snapshot) ? " · " + suffixOf(snapshot) : "");

			var rects = [];
			if (summary && isCount(summary.total) && summary.total > 0) {
				var segments = segmentsOf(summary);
				var x = 3;
				var span = 18;
				for (var i = 0; i < segments.length; i += 1) {
					var segment = segments[i];
					if (!isCount(segment.count) || segment.count <= 0) continue;
					var width = (segment.count / summary.total) * span;
					rects.push(
						el("rect", {
							key: segment.key,
							x: String(x),
							y: "9.5",
							width: String(width),
							height: "5",
							fill: SEGMENT_COLOR[segment.key],
							"data-seg": segment.key,
						}),
					);
					x += width;
				}
			}

			return el(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
					focusable: "false",
					"data-counts": counts,
					style: { display: "block" },
				},
				el("title", null, label),
				el("rect", {
					x: "3",
					y: "9.5",
					width: "18",
					height: "5",
					rx: "1.5",
					fill: "none",
					stroke: "currentColor",
					strokeOpacity: "0.35",
					strokeWidth: "1",
				}),
				rects,
			);
		}

		function TeamProgressIcon(props) {
			var connected = useStoreSnapshot();
			var injected = props && props.snapshot !== undefined;
			return el(TeamGlyph, {
				snapshot: injected ? props.snapshot : connected.snapshot,
				size: (props && props.size) || 18,
			});
		}

			// ===================== mount ===========================================
		// Services resolved opportunistically at mount. `uiWorkspace` is optional:
		// without it the member names are not clickable, and nothing else changes.
		var svc = { workspace: null };
		function mount(ctx) {
			svc.workspace = ctx.get("uiWorkspace");
			var slots = ctx.get("slots");
			if (!slots || typeof slots.register !== "function") return;
			var styles = makeStyles("dsh-team-progress");

			ctx.effect(function () {
				return styles.insert(CSS);
			}, "team-progress: styles");

			// slots.inject() is mandatory, not stylistic: a bare register() at apply
			// time races slot seeding and renders nothing, silently
			// (dsh-mcp-manager/lib/client.js:1047-1051, dsh-setup-manager/lib/client.js:683-685).
			ctx.effect(function () {
				return slots.inject("sidebar.panellist", function () {
					try {
						return slots.register(
							{
								name: "sidebar.panellist",
								id: "team-progress",
								order: 40,
								label: function () {
									return "Team progress";
								},
							},
							TeamProgressIcon,
						);
					} catch (error) {
						fatal("sidebar.panellist registration", error);
						return function () {};
					}
				});
			}, "team-progress: sidebar entry");

			ctx.effect(function () {
				return slots.inject("main", function () {
					try {
						return slots.register({ name: "main", key: "team-progress" }, TeamProgressPanel);
					} catch (error) {
						fatal("main panel registration", error);
						return function () {};
					}
				});
			}, "team-progress: main panel");
		}

		function apply(ctx) {
			// Resolve `slots` defensively: it may not exist yet, and on the client
			// plane an unresolvable module-level `inject` would stop apply() from
			// ever running — which fails silently. Prefer deferred injection, then a
			// bounded retry, then give up loudly.
			if (typeof ctx.inject === "function") {
				try {
					ctx.inject(["slots"], function (inner) {
						try {
							mount(inner || ctx);
						} catch (error) {
							fatal("mount", error);
						}
					});
					return;
				} catch (error) {
					/* fall through to the polling path */
				}
			}

			var attempts = 0;
			(function attempt() {
				attempts += 1;
				if (ctx.get && ctx.get("slots")) {
					try {
						mount(ctx);
					} catch (error) {
						fatal("mount", error);
					}
					return;
				}
				if (attempts > 40) {
					fatal("startup", new Error("slots service never appeared"));
					return;
				}
				setTimeout(attempt, 100);
			})();
		}

		exports.apply = apply;
		return module.exports;
	},
});
