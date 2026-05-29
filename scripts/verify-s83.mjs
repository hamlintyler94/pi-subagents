/**
 * verify-s83.mjs — Headless live-rendering verification of the §8.3 checklist.
 *
 * Drives the BUILT modules (dist/) with the REAL pi-tui width measurement and a
 * realistic captured ctx.ui, feeding real arrow/enter/number/esc byte sequences and
 * measuring the actual rendered output. This exercises the real rendering + nav code
 * paths (not the fake-ctx unit tests), and measures glyph/line widths with the same
 * stringWidth pi uses — so the "needs a human eye" items (#10 glyph, #11 narrow term)
 * are mechanically checked here.
 *
 * Run: node scripts/verify-s83.mjs
 */
import { visibleWidth as stringWidth } from "@earendil-works/pi-tui";
import {
  EDITOR,
  resolveNavKey,
  resolveNumberJump,
} from "../dist/ui/nav-state.js";
import {
  formatTurnCount,
  formatSessionRow,
  renderSessionList,
  formatPaneHeader,
  formatBreadcrumb,
} from "../dist/ui/session-row-format.js";
import { SessionNavController } from "../dist/ui/session-nav-controller.js";
import { buildTranscriptLines } from "../dist/ui/transcript-builder.js";

const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b" };
// Identity theme: fg/bold return text unchanged so stringWidth measures TRUE visible
// width (ANSI is zero-width anyway, but this keeps the measurement unambiguous).
const theme = { fg: (_c, t) => t, bold: (t) => t };

let pass = 0, fail = 0;
const results = [];
function check(id, cond, detail) {
  (cond ? pass++ : fail++);
  results.push(`${cond ? "PASS" : "FAIL"}  ${id}  ${detail}`);
}

// ---- Fake but realistic agent manager + records --------------------------------
function rec(id, type, status, startedAt, opts = {}) {
  return {
    id, type, status, startedAt,
    completedAt: opts.completedAt,
    description: opts.description ?? `${type} task`,
    toolUses: opts.toolUses ?? 0,
    compactionCount: 0,
    lifetimeUsage: opts.lifetimeUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    invocation: opts.modelName ? { modelName: opts.modelName } : undefined,
    session: opts.session,
    pendingSteers: opts.pendingSteers,
  };
}
function makeManager(records) {
  return {
    _records: records,
    listAgents() { return this._records; },
    getRecord(id) { return this._records.find(r => r.id === id); },
  };
}

// ---- Captured ctx.ui (records real factory render output) -----------------------
function makeCtx(columns) {
  // overlayActive is toggleable to simulate a foreign capturing overlay (ask-user-question).
  const state = { widgetLines: [], status: {}, editorText: "", inputHandler: null, paneFactoryCalled: false, consumedKeys: [], overlayActive: false };
  const fakeTui = { terminal: { columns }, requestRender() {}, hasOverlay: () => state.overlayActive };
  const ctx = {
    setStatus(key, text) { state.status[key] = text; },
    setWidget(_key, factory) {
      if (!factory) { state.widgetLines = []; return; }
      const comp = factory(fakeTui, theme);
      state.widgetComp = comp;
      state.widgetLines = comp.render();
    },
    onTerminalInput(handler) { state.inputHandler = handler; return () => { state.inputHandler = null; }; },
    getEditorText() { return state.editorText; },
    setEditorText(t) { state.editorText = t; },
    custom(factory) {
      state.paneFactoryCalled = true;
      const done = () => {};
      // The pane factory needs a real-ish session; pass a stub the TranscriptPane can hold.
      try { factory(fakeTui, theme, {}, done); } catch (_e) { /* pane needs live session; ok */ }
      return new Promise(() => {}); // never resolves (overlay stays up)
    },
  };
  // re-render helper: re-invoke the stored widget component
  ctx._rerender = () => { if (state.widgetComp) state.widgetLines = state.widgetComp.render(); };
  return { ctx, fakeTui, state };
}

function feed(controller, state, data) {
  const r = state.inputHandler ? state.inputHandler(data) : undefined;
  state._rerender?.();
  return r;
}

// ================================================================================
// §8.3 #1 / #2 / FR-2 / FR-13 — caret-first arrows; ↓ mid-text passes to editor
// ================================================================================
{
  // multi-line text, caret NOT at last line → ↓ must pass to editor (consume=false)
  const r = resolveNavKey({
    state: { highlightIndex: EDITOR, inViewIndex: 0 }, key: "down",
    caret: { atFirstLine: true, atLastLine: false, isEmpty: false }, listLength: 3,
  });
  check("#1/#2 FR-2", r.consume === false && r.effect.kind === "passToEditor" && r.state.highlightIndex === EDITOR,
    `↓ mid-text → passToEditor, stays in editor (consume=${r.consume})`);
  // ←/→ always pass-through (FR-13)
  const rl = resolveNavKey({ state: { highlightIndex: 2, inViewIndex: 0 }, key: "left", caret: { atFirstLine: false, atLastLine: false, isEmpty: false }, listLength: 3 });
  check("#1 FR-13", rl.consume === false && rl.effect.kind === "passToEditor", "←/→ always pass to editor");
}

// ================================================================================
// BUG A — while a foreign capturing overlay (ask-user-question) is up, our nav must
// NOT consume arrows/digits: they belong to that overlay until it closes.
// ================================================================================
{
  const mgr = makeManager([
    rec("a", "Explore", "running", 1000),
    rec("b", "Plan", "running", 1100),
  ]);
  const { ctx, state } = makeCtx(120);
  state._rerender = ctx._rerender;
  const ctrl = new SessionNavController(mgr, new Map(), () => undefined);
  ctrl.setUICtx(ctx);
  ctrl.refresh();
  // Drop focus into the list first so nav WOULD normally consume ↓.
  feed(ctrl, state, KEY.down); // → main(0)
  const hBefore = ctrl.getState().highlightIndex;
  // Now a foreign capturing overlay opens (e.g. ask-user-question).
  state.overlayActive = true;
  const retDown = state.inputHandler(KEY.down); // should pass through (undefined), no nav
  const retDigit = state.inputHandler("2");      // digit should also pass through
  const hAfter = ctrl.getState().highlightIndex;
  check("BUG-A overlay-passthrough",
    retDown === undefined && retDigit === undefined && hAfter === hBefore,
    `overlay up → ↓ ret=${JSON.stringify(retDown)}, digit ret=${JSON.stringify(retDigit)}, highlight unchanged (${hBefore}→${hAfter})`);
  // Once the overlay closes, nav resumes.
  state.overlayActive = false;
  const retResume = state.inputHandler(KEY.down);
  check("BUG-A resume-after-close",
    retResume && retResume.consume === true && ctrl.getState().highlightIndex === hBefore + 1,
    `overlay closed → ↓ resumes nav (highlight ${hBefore}→${ctrl.getState().highlightIndex})`);
  // BUG-C: a consumed nav key MUST also set handled+preventDefault, because pi-tui's
  // notifyInputListeners only stops editor propagation on result.handled (not .consume).
  check("BUG-C consume-sets-handled",
    retResume && retResume.handled === true && retResume.preventDefault === true,
    `consume result carries handled+preventDefault for real pi-tui InputListener (got ${JSON.stringify(retResume)})`);
}

// ================================================================================
// §8.3 #2 / FR-1 — empty/bottom: ↓ drops to main(0); ↑ returns to editor
// ================================================================================
{
  const down = resolveNavKey({ state: { highlightIndex: EDITOR, inViewIndex: 0 }, key: "down", caret: { atFirstLine: true, atLastLine: true, isEmpty: true }, listLength: 3 });
  check("#2 FR-1a", down.consume === true && down.state.highlightIndex === 0, `↓ from empty editor → highlight main(0) (idx=${down.state.highlightIndex})`);
  const up = resolveNavKey({ state: { highlightIndex: 0, inViewIndex: 0 }, key: "up", caret: { atFirstLine: true, atLastLine: true, isEmpty: true }, listLength: 3 });
  check("#2 FR-1b", up.consume === true && up.state.highlightIndex === EDITOR && up.effect.kind === "focusEditorEnd", `↑ from main(0) → editor (focusEditorEnd)`);
}

// ================================================================================
// §8.3 #3 / FR-6 — stable spawn-order list incl. finished; ↓ walks it
// ================================================================================
{
  const mgr = makeManager([
    rec("a", "Explore", "completed", 1000, { completedAt: 1800, modelName: "haiku" }),
    rec("b", "Plan", "running", 1100, { modelName: "sonnet" }),
    rec("c", "general-purpose", "running", 1200),
  ]);
  const { ctx, state } = makeCtx(120);
  state._rerender = ctx._rerender;
  const ctrl = new SessionNavController(mgr, new Map(), () => undefined);
  ctrl.setUICtx(ctx);
  ctrl.refresh();
  // Walk down: editor → main(0) → 1 → 2 → 3
  feed(ctrl, state, KEY.down); // → main(0)
  const idxs = [];
  for (let i = 0; i < 3; i++) { feed(ctrl, state, KEY.down); idxs.push(ctrl.getState().highlightIndex); }
  check("#3 FR-6a", JSON.stringify(idxs) === JSON.stringify([1, 2, 3]), `↓ walks list in order: ${idxs.join(",")}`);
  // finished agent 'a' (earliest spawn, id "a") is row 1 and present + completed.
  // (Display name resolves via the agent registry, which isn't initialized in this
  // standalone harness, so assert on stable index/status/main-ness, not the label.)
  const rows = ctrl.buildRows();
  check("#3 FR-6b", rows.length === 4 && rows[0].isMain && !rows[1].isMain && rows[1].index === 1 && rows[1].status === "completed",
    `main(0)+3 rows; row1 = finished(completed) earliest-spawn agent; ${rows.length} rows total`);
}

// ================================================================================
// §8.3 #4 / FR-3 / FR-7 — Enter on subagent sets in-view + pane; header has model/ctx/activity
// ================================================================================
{
  const mgr = makeManager([
    rec("b", "Plan", "running", 1100, { modelName: "sonnet", session: { /* stub */ } }),
  ]);
  const { ctx, state } = makeCtx(120);
  state._rerender = ctx._rerender;
  const ctrl = new SessionNavController(mgr, new Map(), () => undefined);
  ctrl.setUICtx(ctx);
  ctrl.refresh();
  feed(ctrl, state, KEY.down); // main(0)
  feed(ctrl, state, KEY.down); // Plan(1)
  feed(ctrl, state, KEY.enter);
  check("#4 FR-3a", ctrl.getInViewSessionId() === "b", `Enter on Plan → in-view = b (${ctrl.getInViewSessionId()})`);
  check("#4 FR-3b", state.paneFactoryCalled === true, `transcript pane mounted via custom() (factory called=${state.paneFactoryCalled})`);
  // Enter on main(0) hides pane
  feed(ctrl, state, KEY.up); // highlight → main(0)? (from row1 up → main0)
  // jump to main via number 0 to be deterministic
  feed(ctrl, state, "0");
  check("#4 FR-3c", ctrl.getInViewSessionId() === undefined, `0/main → pane hidden (in-view=${ctrl.getInViewSessionId()})`);
  // pane header content (FR-7): model + ctx% + activity present
  const hdr = formatPaneHeader({ name: "Plan", index: 1, status: "running", timing: "4.2s", modelName: "sonnet", contextPercent: 31, tokens: 12300, activity: "searching…" }, theme);
  check("#4 FR-7", hdr.includes("sonnet") && hdr.includes("31%") && hdr.includes("searching"), `pane header has model+ctx%+activity: "${hdr}"`);
}

// ================================================================================
// §8.3 #5 / FR-4 — steer running subagent in view; suppress main
// ================================================================================
{
  const mgr = makeManager([rec("b", "Plan", "running", 1100, { pendingSteers: [] })]);
  const { ctx, state } = makeCtx(120);
  state._rerender = ctx._rerender;
  const ctrl = new SessionNavController(mgr, new Map(), () => undefined);
  ctrl.setUICtx(ctx);
  ctrl.refresh();
  feed(ctrl, state, KEY.down); feed(ctrl, state, KEY.down); feed(ctrl, state, KEY.enter); // view Plan
  const decision = ctrl.routeInput("steer this please");
  const buffered = mgr.getRecord("b").pendingSteers;
  check("#5 FR-4", decision === "handled" && buffered.includes("steer this please"),
    `running in-view: routeInput→"${decision}", steer buffered=${JSON.stringify(buffered)}`);
}

// ================================================================================
// §8.3 #6 / FR-5 — finished subagent in view: input disabled + hint, submit no-op
// ================================================================================
{
  const mgr = makeManager([rec("a", "Explore", "completed", 1000, { completedAt: 1800 })]);
  const { ctx, state } = makeCtx(120);
  state._rerender = ctx._rerender;
  const ctrl = new SessionNavController(mgr, new Map(), () => undefined);
  ctrl.setUICtx(ctx);
  ctrl.refresh();
  feed(ctrl, state, KEY.down); feed(ctrl, state, KEY.down); feed(ctrl, state, KEY.enter); // view Explore (finished)
  const decision = ctrl.routeInput("should be swallowed");
  const hint = state.status["subagent-nav-crumb"];
  check("#6 FR-5", decision === "handled" && /disabled/i.test(hint ?? ""),
    `finished in-view: routeInput→"${decision}", hint="${hint}"`);
}

// ================================================================================
// §8.3 #7 / FR-9 — number jump 0-9; 0 → main
// ================================================================================
{
  const r2 = resolveNumberJump({ highlightIndex: 0, inViewIndex: 0 }, 2, 4);
  check("#7 FR-9a", r2.consume && r2.state.inViewIndex === 2 && r2.effect.kind === "view", `digit 2 → in-view 2`);
  const r0 = resolveNumberJump({ highlightIndex: 2, inViewIndex: 2 }, 0, 4);
  check("#7 FR-9b", r0.consume && r0.state.inViewIndex === 0, `digit 0 → main`);
  const rOut = resolveNumberJump({ highlightIndex: 0, inViewIndex: 0 }, 9, 4); // out of range
  check("#7 FR-9c", rOut.consume === false, `out-of-range digit → no-op (consume=${rOut.consume})`);
}

// ================================================================================
// §8.3 #8 / FR-3 / FR-10 — breadcrumb tracks in-view; Esc → main + editor
// ================================================================================
{
  check("#8 FR-3", formatBreadcrumb("Explore", 2, false) === "▸ Explore (2) · Esc or 0 → main" && formatBreadcrumb("main", 0, true) === "▸ main(0)",
    `breadcrumb: "${formatBreadcrumb("Explore", 2, false)}" / "${formatBreadcrumb("main", 0, true)}"`);
  const esc = resolveNavKey({ state: { highlightIndex: 3, inViewIndex: 3 }, key: "escape", caret: { atFirstLine: false, atLastLine: false, isEmpty: false }, listLength: 4 });
  check("#8 FR-10", esc.consume && esc.state.highlightIndex === EDITOR && esc.state.inViewIndex === 0 && esc.effect.kind === "reset",
    `Esc → in-view main + highlight editor`);
}

// ================================================================================
// §8.3 #9 / FR-11 — agent finishes while not in view → attention badge until viewed
// ================================================================================
{
  const recs = [rec("b", "Plan", "running", 1100), rec("a", "Explore", "running", 1000)];
  const mgr = makeManager(recs);
  const { ctx, state } = makeCtx(120);
  state._rerender = ctx._rerender;
  const ctrl = new SessionNavController(mgr, new Map(), () => undefined);
  ctrl.setUICtx(ctx);
  ctrl.refresh();
  // 'a' finishes while main is in view (not viewing a)
  mgr.getRecord("a").status = "completed";
  mgr.getRecord("a").completedAt = 2000;
  ctrl.refresh();
  const badged = ctrl.getAttentionSet().has("a");
  check("#9 FR-11a", badged, `finished-while-away 'a' is badged (attentionSet has a=${badged})`);
  // view it → badge clears
  const finishedRow = ctrl.buildRows().find(r => !r.isMain && r.status === "completed");
  check("#9 FR-11b-row", !!finishedRow, `finished row present (idx=${finishedRow?.index})`);
  if (finishedRow) ctrl.jumpToIndex(finishedRow.index);
  check("#9 FR-11b", !ctrl.getAttentionSet().has("a"), `viewing 'a' clears its badge (has(a)=${ctrl.getAttentionSet().has("a")})`);
}

// ================================================================================
// §8.3 #10 / FR-12 — turn-count glyph: literal space between ⟳ and digit (no collision)
// ================================================================================
{
  const s = formatTurnCount(5);
  const sMax = formatTurnCount(5, 30);
  const hasSpace = s === "⟳ 5" && sMax === "⟳ 5≤30";
  // Measure: the cell after the glyph is a space (width 1) BEFORE the digit, so even if
  // ⟳ renders 1.5-wide the digit cannot overlap it. Verify glyph+space occupy >= digit start.
  const glyphPlusSpace = "⟳ ";
  const w = stringWidth(glyphPlusSpace);
  check("#10 FR-12", hasSpace && w >= 2, `glyph form "${s}" / "${sMax}"; stringWidth("⟳ ")=${w} (separator guarantees no digit overlap)`);
}

// ================================================================================
// §8.3 #11 — narrow terminal: rendered rows must fit the terminal width (no overflow)
// ================================================================================
{
  const mgr = makeManager([
    rec("a", "Explore", "completed", 1000, { completedAt: 1800, modelName: "haiku", description: "investigate the very long thing that would overflow a narrow terminal badly", lifetimeUsage: { input: 12000, output: 1000, cacheRead: 0, cacheWrite: 300 } }),
    rec("b", "general-purpose", "running", 1100, { modelName: "sonnet" }),
  ]);
  for (const cols of [20, 40, 80]) {
    const { ctx, state } = makeCtx(cols);
    state._rerender = ctx._rerender;
    const ctrl = new SessionNavController(mgr, new Map(), () => undefined);
    ctrl.setUICtx(ctx);
    ctrl.refresh();
    const lines = state.widgetLines;
    const over = lines.filter(l => stringWidth(l) > cols);
    check(`#11 cols=${cols}`, over.length === 0,
      `${lines.length} rows; ${over.length} exceed ${cols} cols${over.length ? " → [" + over.map(l => `${stringWidth(l)}:${JSON.stringify(l)}`).join(" | ") + "]" : ""}`);
  }
}

// ---- Report --------------------------------------------------------------------
import { writeFileSync } from "node:fs";
const report = [
  "=== §8.3 live-rendering verification (real pi-tui visibleWidth, built dist/ modules) ===",
  "",
  ...results,
  "",
  `TOTAL: ${pass} pass, ${fail} fail`,
  `CHECKS: ${results.length}`,
].join("\n");
writeFileSync(new URL("./verify-s83.out.txt", import.meta.url), report + "\n");
console.log(report);
// Corruption-resistant single-token counters (each unique, easy to grep exactly).
console.log(`PASSCOUNT_${pass}_END`);
console.log(`FAILCOUNT_${fail}_END`);
console.log(`CHECKCOUNT_${results.length}_END`);
// Exit code = fail count (capped at 100) so $? directly encodes failures even when
// buffered stdout is unreliable. 0 = all pass.
process.exit(Math.min(fail, 100));
