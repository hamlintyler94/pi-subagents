import { describe, expect, it } from "vitest";
import {
  type CaretInfo,
  EDITOR,
  type NavState,
  resolveNavKey,
  resolveNumberJump,
} from "../src/ui/nav-state.js";

// Caret presets
const empty: CaretInfo = { atFirstLine: true, atLastLine: true, isEmpty: true };
const singleLine: CaretInfo = { atFirstLine: true, atLastLine: true, isEmpty: false };
const midText: CaretInfo = { atFirstLine: false, atLastLine: false, isEmpty: false };
const firstOfMulti: CaretInfo = { atFirstLine: true, atLastLine: false, isEmpty: false };
const lastOfMulti: CaretInfo = { atFirstLine: false, atLastLine: true, isEmpty: false };

const S = (highlightIndex: number, inViewIndex = 0): NavState => ({ highlightIndex, inViewIndex });

describe("resolveNavKey — boundary fall-through (FR-1, FR-2)", () => {
  it("FR-1: ↓ from empty editor drops highlight to main(0) and consumes", () => {
    const r = resolveNavKey({ state: S(EDITOR), key: "down", caret: empty, listLength: 3 });
    expect(r.state.highlightIndex).toBe(0);
    expect(r.consume).toBe(true);
  });

  it("FR-2: ↓ mid-text passes to editor (does NOT cross into the list)", () => {
    const r = resolveNavKey({ state: S(EDITOR), key: "down", caret: midText, listLength: 3 });
    expect(r.state.highlightIndex).toBe(EDITOR);
    expect(r.effect.kind).toBe("passToEditor");
    expect(r.consume).toBe(false);
  });

  it("FR-2: ↓ on last line of multi-line text crosses into main(0)", () => {
    const r = resolveNavKey({ state: S(EDITOR), key: "down", caret: lastOfMulti, listLength: 3 });
    expect(r.state.highlightIndex).toBe(0);
    expect(r.consume).toBe(true);
  });

  it("FR-2: ↓ on first line of multi-line text stays in editor", () => {
    const r = resolveNavKey({ state: S(EDITOR), key: "down", caret: firstOfMulti, listLength: 3 });
    expect(r.state.highlightIndex).toBe(EDITOR);
    expect(r.consume).toBe(false);
  });

  it("FR-1: ↑ from main(0) returns caret to editor end and consumes", () => {
    const r = resolveNavKey({ state: S(0), key: "up", caret: empty, listLength: 3 });
    expect(r.state.highlightIndex).toBe(EDITOR);
    expect(r.effect.kind).toBe("focusEditorEnd");
    expect(r.consume).toBe(true);
  });

  it("↑ in the editor always stays in the editor (nothing above it)", () => {
    const r = resolveNavKey({ state: S(EDITOR), key: "up", caret: singleLine, listLength: 3 });
    expect(r.state.highlightIndex).toBe(EDITOR);
    expect(r.consume).toBe(false);
  });

  it("↓ within the list moves highlight down, clamped at the last row", () => {
    expect(resolveNavKey({ state: S(0), key: "down", caret: empty, listLength: 3 }).state.highlightIndex).toBe(1);
    expect(resolveNavKey({ state: S(2), key: "down", caret: empty, listLength: 3 }).state.highlightIndex).toBe(2);
  });

  it("↑ within the list moves highlight up toward main(0)", () => {
    expect(resolveNavKey({ state: S(2), key: "up", caret: empty, listLength: 3 }).state.highlightIndex).toBe(1);
  });
});

describe("resolveNavKey — Enter (FR-3)", () => {
  it("Enter on a highlighted row sets inView to that index", () => {
    const r = resolveNavKey({ state: S(2), key: "enter", caret: empty, listLength: 3 });
    expect(r.effect).toEqual({ kind: "view", index: 2 });
    expect(r.state.inViewIndex).toBe(2);
    expect(r.consume).toBe(true);
  });

  it("Enter on main(0) views main (pane hidden)", () => {
    const r = resolveNavKey({ state: S(0), key: "enter", caret: empty, listLength: 3 });
    expect(r.effect).toEqual({ kind: "view", index: 0 });
  });

  it("Enter in the editor passes through (submit) and is not consumed", () => {
    const r = resolveNavKey({ state: S(EDITOR), key: "enter", caret: singleLine, listLength: 3 });
    expect(r.effect.kind).toBe("passToEditor");
    expect(r.consume).toBe(false);
  });
});

describe("resolveNavKey — Esc (FR-10) and arrows-as-text", () => {
  it("Esc resets in-view to main and highlight to editor", () => {
    const r = resolveNavKey({ state: S(2, 2), key: "escape", caret: empty, listLength: 3 });
    expect(r.state).toEqual({ highlightIndex: EDITOR, inViewIndex: 0 });
    expect(r.effect.kind).toBe("reset");
    expect(r.consume).toBe(true);
  });

  it("←/→ always pass to the editor and never move highlight (FR-13)", () => {
    for (const key of ["left", "right"] as const) {
      const r = resolveNavKey({ state: S(1), key, caret: midText, listLength: 3 });
      expect(r.effect.kind).toBe("passToEditor");
      expect(r.consume).toBe(false);
      expect(r.state.highlightIndex).toBe(1);
    }
  });
});

describe("resolveNumberJump (FR-9)", () => {
  it("jumps in-view + highlight to a valid index", () => {
    const r = resolveNumberJump(S(EDITOR), 2, 4);
    expect(r.state).toEqual({ highlightIndex: 2, inViewIndex: 2 });
    expect(r.effect).toEqual({ kind: "view", index: 2 });
    expect(r.consume).toBe(true);
  });

  it("0 returns to main", () => {
    const r = resolveNumberJump(S(3, 3), 0, 4);
    expect(r.state.inViewIndex).toBe(0);
  });

  it("out-of-range digit is a no-op and not consumed", () => {
    const r = resolveNumberJump(S(0), 7, 3);
    expect(r.consume).toBe(false);
    expect(r.effect.kind).toBe("none");
  });
});
