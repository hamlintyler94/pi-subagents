/**
 * nav-state.ts — Pure navigation state machine for the unified session stack.
 *
 * Two independent pieces of state (spec §3.2):
 *  - highlightIndex: where the ↑/↓ cursor is. EDITOR is a distinct "above main(0)"
 *    location, modelled here as the sentinel `EDITOR` (-1). main(0) is index 0,
 *    subagents are 1..N.
 *  - inViewSessionId: whose transcript is rendered (changed only by Enter / number / Esc).
 *
 * This module is free of any TUI dependency so it can be table-tested headlessly.
 * The controller feeds it `caretAtBoundary` info (derived from the editor heuristic,
 * S0.2 approach B) and the current list length.
 */

/** Sentinel highlight value meaning "focus is in the editor, not the list". */
export const EDITOR = -1;

/** A normalized navigation key. Arrows are the only ones that move the highlight. */
export type NavKey = "up" | "down" | "enter" | "escape" | "left" | "right";

/** Where the text caret sits, used only when focus is in the editor (highlight === EDITOR). */
export interface CaretInfo {
  /** True when the caret is on the FIRST visual/logical line of the editor text. */
  atFirstLine: boolean;
  /** True when the caret is on the LAST visual/logical line of the editor text. */
  atLastLine: boolean;
  /** True when the editor has no text at all. */
  isEmpty: boolean;
}

/** Snapshot of nav state the machine reads/writes. */
export interface NavState {
  /** EDITOR (-1) | 0 (main) | 1..N (subagents). */
  highlightIndex: number;
  /** List index of the in-view session. 0 = main. */
  inViewIndex: number;
}

/** What the controller should do as a result of a key, in addition to the new state. */
export type NavEffect =
  | { kind: "none" }
  /** Pass the key through to the editor unchanged (caret movement / typing). */
  | { kind: "passToEditor" }
  /** Move the text caret to the very end of the editor (returning from main → editor). */
  | { kind: "focusEditorEnd" }
  /** Commit: set in-view to `index` and render it (Enter / number jump). */
  | { kind: "view"; index: number }
  /** Esc quick-return: in-view → main, highlight → editor. */
  | { kind: "reset" };

export interface NavResult {
  state: NavState;
  effect: NavEffect;
  /** True when the key was consumed by nav and must NOT also reach the editor. */
  consume: boolean;
}

/** Inputs to the resolver. `listLength` includes main(0), so it is >= 1. */
export interface NavInput {
  state: NavState;
  key: NavKey;
  caret: CaretInfo;
  /** Total rows incl. main(0). Highlight can range EDITOR..(listLength-1). */
  listLength: number;
}

/** Clamp a list index into [0, listLength-1]. */
function clampIndex(i: number, listLength: number): number {
  if (i < 0) return 0;
  const max = Math.max(0, listLength - 1);
  return i > max ? max : i;
}

/**
 * Core transition. Pure: given current state + key + caret + list length, returns
 * the next state, the effect the controller should apply, and whether to consume.
 *
 * Boundary fall-through (spec §3.2):
 *  - In EDITOR: ←/→ and typing always pass to editor. ↑ passes to editor UNLESS the
 *    caret is on the first line AND the editor is empty (nothing to scroll up into —
 *    stay in editor; there is nothing above the editor). ↓ passes to editor UNLESS the
 *    caret is on the last line (or empty) → fall through to highlight = main(0).
 *  - In the list (highlight >= 0): ↑/↓ move the highlight. ↑ off main(0) → EDITOR
 *    (focusEditorEnd). ↓ past the last row stays on the last row.
 *  - Enter: in EDITOR with text → passToEditor (submit). On a row → view(index).
 *  - Escape: reset (in-view → main, highlight → EDITOR).
 *  - Left/Right: always passToEditor.
 */
export function resolveNavKey(input: NavInput): NavResult {
  const { state, key, caret, listLength } = input;
  const inEditor = state.highlightIndex === EDITOR;

  // Left/Right are never nav.
  if (key === "left" || key === "right") {
    return { state, effect: { kind: "passToEditor" }, consume: false };
  }

  if (key === "escape") {
    return {
      state: { highlightIndex: EDITOR, inViewIndex: 0 },
      effect: { kind: "reset" },
      consume: true,
    };
  }

  if (key === "enter") {
    if (inEditor) {
      // Editor submit — let the host handle it (routing happens via pi.on("input")).
      return { state, effect: { kind: "passToEditor" }, consume: false };
    }
    // On a row: render that session.
    const idx = clampIndex(state.highlightIndex, listLength);
    return {
      state: { ...state, highlightIndex: idx, inViewIndex: idx },
      effect: { kind: "view", index: idx },
      consume: true,
    };
  }

  if (key === "up") {
    if (inEditor) {
      // Only fall "up" out of the editor if there is nowhere above — there isn't,
      // the editor is the topmost element. So ↑ always stays in the editor (caret up).
      return { state, effect: { kind: "passToEditor" }, consume: false };
    }
    // In the list.
    if (state.highlightIndex === 0) {
      // ↑ off main(0) → return caret to end of editor text.
      return {
        state: { ...state, highlightIndex: EDITOR },
        effect: { kind: "focusEditorEnd" },
        consume: true,
      };
    }
    const idx = clampIndex(state.highlightIndex - 1, listLength);
    return { state: { ...state, highlightIndex: idx }, effect: { kind: "none" }, consume: true };
  }

  if (key === "down") {
    if (inEditor) {
      // Fall through to main(0) only when there's nothing more to scroll down into:
      // caret on last line, or editor empty.
      if (caret.isEmpty || caret.atLastLine) {
        return {
          state: { ...state, highlightIndex: 0 },
          effect: { kind: "none" },
          consume: true,
        };
      }
      // Otherwise move the caret down within the text.
      return { state, effect: { kind: "passToEditor" }, consume: false };
    }
    // In the list: move down, clamped to last row.
    const idx = clampIndex(state.highlightIndex + 1, listLength);
    return { state: { ...state, highlightIndex: idx }, effect: { kind: "none" }, consume: true };
  }

  return { state, effect: { kind: "none" }, consume: false };
}

/** Number-key jump (0-9): set in-view (and highlight) to that index if it exists. */
export function resolveNumberJump(
  state: NavState,
  digit: number,
  listLength: number,
): NavResult {
  if (digit < 0 || digit >= listLength) {
    // Out of range — no-op, do not consume so the digit can still type if desired.
    return { state, effect: { kind: "none" }, consume: false };
  }
  return {
    state: { highlightIndex: digit, inViewIndex: digit },
    effect: { kind: "view", index: digit },
    consume: true,
  };
}
