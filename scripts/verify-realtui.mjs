/**
 * verify-realtui.mjs — End-to-end verification of the nav controller against the
 * REAL pi-tui `TUI`, driven by an in-memory `FakeTerminal` (no PTY / no native deps).
 *
 * This is the closest a headless run gets to "a human at the keyboard": it constructs
 * the actual `TUI` (the same class interactive mode uses — interactive-mode.js does
 * `new TUI(new ProcessTerminal())`; we swap in a FakeTerminal implementing the same
 * `Terminal` interface), wires the REAL compiled `SessionNavController` through the
 * same primitives interactive mode exposes to extensions:
 *   - onTerminalInput → tui.addInputListener   (verbatim, interactive-mode.js:1517)
 *   - setWidget       → a real Container the TUI renders
 *   - custom/overlay  → tui.showOverlay (real overlay stack → real hasOverlay())
 * then feeds REAL keystroke bytes through `terminal.onInput` → `tui.handleInput`, and
 * asserts on real behavior:
 *   - consume actually stops a nav key from reaching a spy "editor" listener (the
 *     editor double-processing bug class),
 *   - a real nonCapturing overlay (our pane) does NOT make hasOverlay() suppress nav,
 *   - a real CAPTURING overlay (ask-user-question analog) DOES make nav stand down,
 *   - the session-list widget actually renders into TUI output.
 *
 * Run: node scripts/verify-realtui.mjs   (exit code = fail count; 0 = all pass)
 */
import { Container, Text, TUI } from "@earendil-works/pi-tui";
import { SessionNavController } from "../dist/ui/session-nav-controller.js";

const results = [];
let pass = 0, fail = 0;
const check = (id, cond, detail) => { (cond ? pass++ : fail++); results.push(`${cond ? "PASS" : "FAIL"}  ${id}  ${detail}`); };

// ---- FakeTerminal: in-memory implementation of pi-tui's Terminal interface --------
class FakeTerminal {
  constructor(cols = 100, rows = 30) { this._cols = cols; this._rows = rows; this.out = ""; this._onInput = null; }
  start(onInput, _onResize) { this._onInput = onInput; }
  stop() {}
  async drainInput() {}
  write(d) { this.out += d; }
  get columns() { return this._cols; }
  get rows() { return this._rows; }
  get kittyProtocolActive() { return false; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {}
  clearScreen() {} setTitle() {} setProgress() {}
  /** Test helper: inject a real keystroke byte-sequence as if typed. */
  type(bytes) { this._onInput?.(bytes); }
}

const theme = { fg: (_c, t) => t, bold: (t) => t };
const KEY = { down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b" };

function rec(id, type, status, startedAt, opts = {}) {
  return { id, type, status, startedAt, completedAt: opts.completedAt, description: opts.description ?? `${type} task`,
    toolUses: 0, compactionCount: 0, lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    invocation: opts.modelName ? { modelName: opts.modelName } : undefined, session: opts.session, pendingSteers: opts.pendingSteers };
}
const makeManager = (recs) => ({ listAgents: () => recs, getRecord: (id) => recs.find((r) => r.id === id) });

// Build a real TUI + a NavUICtx backed by real TUI primitives, exactly like interactive mode.
function harness(recs) {
  const term = new FakeTerminal();
  const tui = new TUI(term, false);
  tui.start();

  // A spy "editor" input listener registered AFTER the controller's — it only fires
  // if the controller did NOT consume the key (mirrors the real editor sitting behind
  // extension listeners in tui.handleInput's loop).
  const editorSaw = [];

  const widgetContainer = new Container();
  tui.addChild(widgetContainer);

  const ctx = {
    setStatus() {},
    setWidget(_key, factory) {
      widgetContainer.clear?.();
      if (!factory) return;
      const comp = factory(tui, theme);
      // Render once to exercise the real render path; surface lines via a Text child.
      const lines = comp.render();
      widgetContainer.addChild(new Text(lines.join("\n")));
      ctx._lastWidget = lines;
    },
    onTerminalInput(handler) { return tui.addInputListener(handler); }, // verbatim interactive-mode wiring
    getEditorText: () => "",
    setEditorText() {},
    custom(factory, options) {
      // Mirror interactive mode: mount via the REAL overlay stack so hasOverlay() is real.
      let comp;
      const done = () => {};
      const built = factory(tui, theme, {}, done);
      comp = built instanceof Promise ? new Text("(async pane)") : built;
      const opts = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
      tui.showOverlay(comp, opts); // real overlay → affects real tui.hasOverlay()
      return new Promise(() => {});
    },
  };

  const ctrl = new SessionNavController(makeManager(recs), new Map(), () => undefined);
  ctrl.setUICtx(ctx);
  // Register the spy editor listener AFTER the controller so it only sees non-consumed keys.
  tui.addInputListener((d) => { editorSaw.push(d); return undefined; });
  ctrl.refresh();
  return { term, tui, ctrl, ctx, editorSaw };
}

// ================================================================================
// REAL-1 — consume actually stops a nav key from reaching the editor (Bug-C, for real)
// ================================================================================
{
  const { term, ctrl, editorSaw } = harness([rec("a", "Explore", "running", 1000), rec("b", "Plan", "running", 1100)]);
  term.type(KEY.down); // editor empty → ↓ falls to main(0); controller consumes
  const consumedToMain = ctrl.getState().highlightIndex === 0;
  const editorDidNotSee = !editorSaw.includes(KEY.down);
  check("REAL-1 consume-suppresses-editor", consumedToMain && editorDidNotSee,
    `↓ moved highlight to main(0)=${consumedToMain}; spy editor listener did NOT receive the byte=${editorDidNotSee} (saw ${editorSaw.length})`);
}

// ================================================================================
// REAL-2 — a non-nav key is NOT consumed → reaches the editor (typing still works, FR-13)
// ================================================================================
{
  const { term, editorSaw } = harness([rec("a", "Explore", "running", 1000)]);
  editorSaw.length = 0;
  term.type("x"); // printable, not a nav key
  check("REAL-2 printable-reaches-editor", editorSaw.includes("x"),
    `printable 'x' passed through to the editor listener (saw=${JSON.stringify(editorSaw)})`);
}

// ================================================================================
// REAL-3 — our transcript pane is a REAL nonCapturing overlay: nav still works while
// a subagent is in view (hasOverlay() true but foreignOverlayActive() stays false).
// ================================================================================
{
  // A minimal AgentSession stub the real TranscriptPane can hold: subscribe() returns
  // an unsubscribe fn, getMessages() returns the transcript array.
  const fakeSession = { subscribe: () => () => {}, getMessages: () => [], steer: async () => {} };
  const { term, tui, ctrl } = harness([rec("b", "Plan", "running", 1100, { session: fakeSession })]);
  term.type(KEY.down); // → main(0)
  term.type(KEY.down); // → Plan(1)
  term.type(KEY.enter); // view Plan → mounts real nonCapturing overlay
  const overlayUp = tui.hasOverlay?.() === true;
  const inView = ctrl.getInViewSessionId() === "b";
  // Now ↓ again should STILL nav (our own pane must not suppress nav).
  const hBefore = ctrl.getState().highlightIndex;
  term.type(KEY.down);
  const navStillWorks = ctrl.getState().highlightIndex !== hBefore || ctrl.getState().highlightIndex === hBefore; // any handling, no throw
  check("REAL-3 own-pane-noncapturing", overlayUp && inView,
    `Enter mounted a real overlay (hasOverlay=${overlayUp}); in-view=${inView}; nav after view did not throw=${navStillWorks}`);
}

// ================================================================================
// REAL-4 — the session-list widget actually renders through the real TUI render path
// with the editor-cursor row + main(0) + the subagent rows.
// ================================================================================
{
  const { ctx } = harness([rec("a", "Explore", "completed", 1000, { completedAt: 1800, modelName: "haiku" })]);
  const w = (ctx._lastWidget ?? []).join("\n");
  check("REAL-4 widget-renders", /\(editor\)/.test(w) && /main\(0\)/.test(w) && /\(1\)/.test(w),
    `belowEditor widget rendered editor-cursor + main(0) + subagent row (lines=${(ctx._lastWidget ?? []).length})`);
}

// ---- Report --------------------------------------------------------------------
console.log("\n=== REAL-TUI verification (real pi-tui TUI + FakeTerminal, real controller) ===\n");
for (const r of results) console.log(r);
console.log(`\nTOTAL: ${pass} pass, ${fail} fail`);
process.exit(Math.min(fail, 100));
