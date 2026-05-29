import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { type NavUICtx, SessionNavController } from "../src/ui/session-nav-controller.js";
import { IN_VIEW_MARKER } from "../src/ui/session-row-format.js";

// ── Raw key byte-strings (the same strings onTerminalInput receives) ──────────
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

function rec(id: string, startedAt: number, status: AgentRecord["status"] = "running"): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: id,
    status,
    toolUses: 0,
    startedAt,
    lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 },
    compactionCount: 0,
    invocation: { modelName: "haiku" },
    session: {
      messages: [{ role: "user", content: "hi" }],
      subscribe: vi.fn(() => vi.fn()),
      steer: vi.fn(() => Promise.resolve()),
      getSessionStats: () => ({ tokens: { input: 1000, output: 500, cacheWrite: 0 }, contextUsage: { percent: 31 } }),
      dispose: vi.fn(),
    } as any,
  } as AgentRecord;
}

class FakeManager {
  constructor(public records: AgentRecord[]) {}
  listAgents() { return [...this.records].sort((a, b) => b.startedAt - a.startedAt); }
  getRecord(id: string) { return this.records.find(r => r.id === id); }
}

/** Fake ctx.ui capturing all calls; mimics the interactive ExtensionUIContext subset. */
function makeFakeUI() {
  let inputHandler: ((d: string) => any) | undefined;
  let editorText = "";
  const calls = {
    widgets: [] as { key: string; content: any; placement?: string }[],
    status: new Map<string, string | undefined>(),
    customs: [] as any[],
    editorSets: [] as string[],
  };
  const tui = { terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() } as any;
  // Identity theme: zero-width styling so visibleWidth measures real content
  // (mirrors how real ANSI themes add no printable width). Keeps the in-view
  // marker check meaningful while letting the pane header fit the render width.
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  const ui: NavUICtx & { _emit(d: string): any; _renderWidget(): string[]; _tui: any } = {
    setStatus: (key, text) => { calls.status.set(key, text); },
    setWidget: (key, content, options) => {
      calls.widgets.push({ key, content, placement: options?.placement });
    },
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    setEditorText: (t) => { editorText = t; calls.editorSets.push(t); },
    custom: (factory) => {
      // Build the pane component immediately so we can inspect its render output,
      // and never resolve (overlay stays open until done()).
      const comp = factory(tui, theme as any, undefined, () => {});
      calls.customs.push(comp);
      return new Promise<any>(() => {}); // pending forever (overlay open)
    },
    _emit: (d: string) => inputHandler?.(d),
    _renderWidget: () => {
      const w = calls.widgets.filter(x => x.key === "subagent-nav").at(-1);
      const factory = w?.content;
      if (typeof factory !== "function") return [];
      const comp = factory(tui, theme);
      return comp.render();
    },
    _tui: tui,
  } as any;
  return { ui, calls, setEditorText: (t: string) => { editorText = t; } };
}

let activity: Map<string, AgentActivity>;
beforeEach(() => { activity = new Map(); });

function controllerWith(records: AgentRecord[]) {
  const mgr = new FakeManager(records);
  const { ui, calls, setEditorText } = makeFakeUI();
  const ctrl = new SessionNavController(mgr as any, activity, () => undefined);
  ctrl.setUICtx(ui);
  ctrl.refresh();
  return { ctrl, ui, calls, mgr, setEditorText };
}

describe("SessionNavController — widget placement & composition", () => {
  it("mounts the session list belowEditor with main(0) + subagents in spawn order", () => {
    const { ui, calls } = controllerWith([rec("b", 200), rec("a", 100)]);
    const navWidget = calls.widgets.find(w => w.key === "subagent-nav");
    expect(navWidget?.placement).toBe("belowEditor");
    const lines = ui._renderWidget();
    const joined = lines.join("\n");
    expect(joined).toContain("main(0)");
    // spawn order: a(1) before b(2)
    const ai = joined.indexOf("(1)");
    const bi = joined.indexOf("(2)");
    expect(ai).toBeGreaterThan(-1);
    expect(bi).toBeGreaterThan(ai);
  });
});

describe("SessionNavController — navigation (FR-1, FR-3, FR-10)", () => {
  it("FR-1: ↓ from empty editor highlights main(0)", () => {
    const { ctrl, ui } = controllerWith([rec("a", 100)]);
    ui._emit(DOWN); // editor → main(0)
    expect(ctrl.getState().highlightIndex).toBe(0);
  });

  it("FR-3: ↓↓ to a subagent + Enter sets it in-view and mounts the pane", () => {
    const { ctrl, ui, calls } = controllerWith([rec("a", 100)]);
    ui._emit(DOWN); // → main(0)
    ui._emit(DOWN); // → subagent a (index 1)
    expect(ctrl.getState().highlightIndex).toBe(1);
    ui._emit(ENTER);
    expect(ctrl.getInViewSessionId()).toBe("a");
    expect(calls.customs.length).toBe(1); // non-capturing pane mounted

    // Pane header shows the in-view agent's model + ctx (FR-7).
    const paneLines: string[] = calls.customs[0].render(300);
    const text = paneLines.join("\n");
    expect(text).toContain("model: haiku");
    expect(text).toContain("ctx 31%");
  });

  it("FR-3: Enter on main(0) hides the pane (back to native chat)", () => {
    const { ctrl, ui } = controllerWith([rec("a", 100)]);
    ui._emit(DOWN); ui._emit(DOWN); ui._emit(ENTER); // view a
    expect(ctrl.getInViewSessionId()).toBe("a");
    // back up to main(0) and Enter
    ui._emit(UP); // a(1) → main(0)
    ui._emit(ENTER);
    expect(ctrl.getInViewSessionId()).toBeUndefined();
  });

  it("FR-10: Esc returns in-view to main and highlight to the editor", () => {
    const { ctrl, ui } = controllerWith([rec("a", 100)]);
    ui._emit(DOWN); ui._emit(DOWN); ui._emit(ENTER);
    ui._emit(ESC);
    expect(ctrl.getInViewSessionId()).toBeUndefined();
    expect(ctrl.getState().highlightIndex).toBe(-1); // EDITOR
  });

  it("the in-view marker renders on the in-view row (FR-8)", () => {
    const { ui } = controllerWith([rec("a", 100)]);
    ui._emit(DOWN); ui._emit(DOWN); ui._emit(ENTER); // view a
    expect(ui._renderWidget().join("\n")).toContain(IN_VIEW_MARKER);
  });
});

describe("SessionNavController — submit routing (FR-4, FR-5)", () => {
  it("FR-4: submit while a running subagent is in view steers it and suppresses main", () => {
    const a = rec("a", 100, "running");
    const { ctrl, mgr } = controllerWith([a]);
    ctrl.jumpToIndex(1); // view a
    const decision = ctrl.routeInput("focus on tests");
    expect(decision).toBe("handled");
    expect(mgr.getRecord("a")!.session!.steer).toHaveBeenCalledWith("focus on tests");
  });

  it("FR-4: steer is buffered onto pendingSteers when the session isn't ready", () => {
    const a = rec("a", 100, "running");
    a.session = undefined; // not ready yet
    const { ctrl } = controllerWith([a]);
    ctrl.jumpToIndex(1);
    expect(ctrl.routeInput("hold on")).toBe("handled");
    expect(a.pendingSteers).toEqual(["hold on"]);
  });

  it("FR-5: submit while a finished subagent is in view is disabled (handled no-op + hint)", () => {
    const a = rec("a", 100, "completed");
    a.completedAt = 150;
    const { ctrl, calls } = controllerWith([a]);
    ctrl.jumpToIndex(1);
    expect(ctrl.routeInput("anything")).toBe("handled");
    expect(a.session!.steer).not.toHaveBeenCalled();
    const hint = calls.status.get("subagent-nav-crumb");
    expect(hint).toBeTruthy();
    expect(String(hint).toLowerCase()).toContain("disabled");
  });

  it("main in view → routeInput does NOT intercept (returns undefined)", () => {
    const { ctrl } = controllerWith([rec("a", 100)]);
    // default in-view is main
    expect(ctrl.routeInput("normal turn")).toBeUndefined();
  });
});

describe("SessionNavController — non-capturing pane (S0.1)", () => {
  it("typing a printable key is NOT consumed by the controller (reaches the editor)", () => {
    const { ui } = controllerWith([rec("a", 100)]);
    ui._emit(DOWN); ui._emit(DOWN); ui._emit(ENTER); // pane open, viewing a
    const result = ui._emit("x"); // printable
    // controller returns undefined/no-consume for non-nav keys → editor gets it
    expect(result == null || result.consume !== true).toBe(true);
  });
});

describe("SessionNavController — attention badge (FR-11)", () => {
  it("an agent that finishes while not in view gets badged until first viewed", () => {
    const a = rec("a", 100, "running");
    const { ctrl } = controllerWith([a]);
    // finish while main is in view (not viewing a)
    a.status = "completed"; a.completedAt = 150;
    ctrl.refresh();
    expect(ctrl.getAttentionSet().has("a")).toBe(true);
    // view it → badge cleared
    ctrl.jumpToIndex(1);
    expect(ctrl.getAttentionSet().has("a")).toBe(false);
  });

  it("an agent finishing while it IS in view is not badged", () => {
    const a = rec("a", 100, "running");
    const { ctrl } = controllerWith([a]);
    ctrl.jumpToIndex(1); // viewing a
    a.status = "completed"; a.completedAt = 150;
    ctrl.refresh();
    expect(ctrl.getAttentionSet().has("a")).toBe(false);
  });
});

describe("SessionNavController — hardening (Phase 4)", () => {
  it("list grows while highlighted without moving the highlight off the current row", () => {
    const a = rec("a", 100);
    const mgr = new FakeManager([a]);
    const { ui } = makeFakeUI();
    const ctrl = new SessionNavController(mgr as any, activity, () => undefined);
    ctrl.setUICtx(ui);
    ctrl.refresh();
    ui._emit(DOWN); ui._emit(DOWN); // highlight a(1)
    expect(ctrl.getState().highlightIndex).toBe(1);
    // a new agent appears
    mgr.records.push(rec("b", 200));
    ctrl.refresh();
    expect(ctrl.getState().highlightIndex).toBe(1); // unchanged
  });

  it("in-view agent pruned → falls back to main", () => {
    const a = rec("a", 100);
    const mgr = new FakeManager([a]);
    const { ui } = makeFakeUI();
    const ctrl = new SessionNavController(mgr as any, activity, () => undefined);
    ctrl.setUICtx(ui);
    ctrl.refresh();
    ctrl.jumpToIndex(1);
    expect(ctrl.getInViewSessionId()).toBe("a");
    mgr.records = []; // agent gone
    ctrl.refresh();
    expect(ctrl.getInViewSessionId()).toBeUndefined();
  });
});
