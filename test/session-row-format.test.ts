import { describe, expect, it } from "vitest";
import {
  formatBreadcrumb,
  formatPaneHeader,
  formatRowTokens,
  formatSessionRow,
  formatTurnCount,
  IN_VIEW_MARKER,
  type RowModel,
  renderSessionList,
} from "../src/ui/session-row-format.js";

// Theme that wraps colors as <c>...</c> so assertions can see structure.
const theme = {
  fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
  bold: (s: string) => `*${s}*`,
};

function row(over: Partial<RowModel> = {}): RowModel {
  return {
    index: 1,
    isMain: false,
    name: "Explore",
    status: "running",
    inView: false,
    highlighted: false,
    ...over,
  };
}

describe("formatTurnCount — glyph fix regression (FR-12, §9)", () => {
  // PINNED exact strings: a single space MUST separate the ⟳ glyph from the digit
  // so the East-Asian-Ambiguous-width glyph cannot collide with the number.
  it("without max", () => {
    expect(formatTurnCount(5)).toBe("⟳ 5");
  });
  it("with max", () => {
    expect(formatTurnCount(5, 30)).toBe("⟳ 5≤30");
  });
  it("zero turns still separated", () => {
    expect(formatTurnCount(0)).toBe("⟳ 0");
  });
  it("never emits the colliding form ⟳<digit>", () => {
    expect(formatTurnCount(12)).not.toBe("⟳12");
    expect(formatTurnCount(12)).toContain("⟳ ");
  });
});

describe("formatRowTokens (FR-7)", () => {
  it("formats tokens + context percent", () => {
    expect(formatRowTokens(12300, 45)).toBe("12.3k tok · 45%");
  });
  it("tokens only when percent null", () => {
    expect(formatRowTokens(900, null)).toBe("900 tok");
  });
  it("percent only when tokens zero", () => {
    expect(formatRowTokens(0, 31)).toBe("31%");
  });
  it("empty when nothing to show", () => {
    expect(formatRowTokens(0, null)).toBe("");
  });
});

describe("formatSessionRow (FR-7, FR-8, FR-11)", () => {
  it("shows model name, ctx%, tokens, and activity (FR-7)", () => {
    const out = formatSessionRow(
      row({ modelName: "haiku", contextPercent: 31, tokens: 12300, activity: "searching…" }),
      theme,
    );
    expect(out).toContain("Explore(1)");
    expect(out).toContain("haiku");
    expect(out).toContain("31%");
    expect(out).toContain("12.3k tok");
    expect(out).toContain("searching…");
  });

  it("in-view rows carry the persistent in-view marker (FR-8)", () => {
    const out = formatSessionRow(row({ inView: true }), theme);
    expect(out).toContain(IN_VIEW_MARKER);
  });

  it("highlight cursor and in-view marker are independent (FR-8)", () => {
    // Highlighted but NOT in view → cursor caret present, no in-view marker.
    const hi = formatSessionRow(row({ highlighted: true, inView: false }), theme);
    expect(hi).toContain("›");
    expect(hi).not.toContain(IN_VIEW_MARKER);
    // In view but NOT highlighted → marker present, no cursor caret.
    const iv = formatSessionRow(row({ highlighted: false, inView: true }), theme);
    expect(iv).toContain(IN_VIEW_MARKER);
    expect(iv).not.toContain("›");
  });

  it("attention badge shows only when finished-while-away and not in view (FR-11)", () => {
    const badged = formatSessionRow(row({ status: "completed", attention: true, inView: false }), theme);
    expect(badged).toContain("<warning>●</warning>");
    // Once in view, the badge is suppressed.
    const viewed = formatSessionRow(row({ status: "completed", attention: true, inView: true }), theme);
    expect(viewed).not.toContain("<warning>●</warning>");
  });

  it("status glyph reflects state", () => {
    expect(formatSessionRow(row({ status: "running" }), theme)).toContain("●");
    expect(formatSessionRow(row({ status: "completed" }), theme)).toContain("✓");
    expect(formatSessionRow(row({ status: "error" }), theme)).toContain("✗");
  });
});

describe("formatPaneHeader (FR-7)", () => {
  it("guarantees model, ctx%, and activity in the header", () => {
    const out = formatPaneHeader(
      {
        name: "Explore",
        index: 2,
        status: "running",
        timing: "4.2s (running)",
        modelName: "haiku",
        contextPercent: 31,
        tokens: 12300,
        activity: "reading file…",
      },
      theme,
    );
    expect(out).toContain("Explore (2)");
    expect(out).toContain("model: haiku");
    expect(out).toContain("ctx 31%");
    expect(out).toContain("reading file…");
  });
});

describe("formatBreadcrumb (FR-3)", () => {
  it("main vs subagent", () => {
    expect(formatBreadcrumb("main", 0, true)).toBe("▸ main(0)");
    // Subagent breadcrumb carries the always-visible way-back hint (Esc / 0 → main).
    expect(formatBreadcrumb("Explore", 2, false)).toBe("▸ Explore (2) · Esc or 0 → main");
  });
});

describe("renderSessionList composition", () => {
  it("prepends an (editor) cursor row and one line per row", () => {
    const lines = renderSessionList(
      [row({ index: 0, isMain: true, name: "main" }), row({ index: 1, name: "Explore" })],
      true,
      theme,
    );
    expect(lines[0]).toContain("(editor)");
    expect(lines[0]).toContain("›"); // editor highlighted
    expect(lines.length).toBe(3); // editor row + 2 session rows
  });
});
