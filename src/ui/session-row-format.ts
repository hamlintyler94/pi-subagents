/**
 * session-row-format.ts — Pure formatters for the vertical session list rows and
 * the in-view pane header (spec §3.4, §3.5, §7, §9).
 *
 * Every function here is theme-injected and string-only so it can be unit-tested
 * without a TUI. The widget renderer composes these into themed lines.
 */

import type { Theme } from "./theme.js";

/** Status glyphs (spec §3.4). */
export const GLYPH_RUNNING = "●";
export const GLYPH_QUEUED = "◦";
export const GLYPH_COMPLETED = "✓";
export const GLYPH_ERROR = "✗";
export const GLYPH_STOPPED = "■";

/** The in-view marker (spec §3.5). */
export const IN_VIEW_MARKER = "◀ in view";

/**
 * FR-12 turn-count glyph fix (§9).
 *
 * `⟳` (U+27F3) is East-Asian-width Ambiguous and overhangs the following digit on
 * many terminal fonts, so `⟳5` collides. Fix: emit a separating space between the
 * glyph and the number — `⟳ 5` / `⟳ 5≤30`. This is the single source of truth for
 * the turn marker; the regression test pins the exact strings.
 */
export const TURN_GLYPH = "⟳";

export function formatTurnCount(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `${TURN_GLYPH} ${turnCount}≤${maxTurns}` : `${TURN_GLYPH} ${turnCount}`;
}

/** Pick the status glyph for a row, given the agent status (or "running" for main when busy). */
export function statusGlyph(status: string): string {
  switch (status) {
    case "running":
      return GLYPH_RUNNING;
    case "queued":
      return GLYPH_QUEUED;
    case "completed":
      return GLYPH_COMPLETED;
    case "steered":
      return GLYPH_COMPLETED;
    case "stopped":
      return GLYPH_STOPPED;
    case "error":
    case "aborted":
      return GLYPH_ERROR;
    default:
      return GLYPH_QUEUED;
  }
}

/** Theme color for a status glyph. */
function glyphColor(status: string): string {
  switch (status) {
    case "running":
      return "accent";
    case "completed":
      return "success";
    case "steered":
      return "warning";
    case "error":
    case "aborted":
      return "error";
    default:
      return "dim";
  }
}

/** Fields needed to render one list row. Pure data — no UI types. */
export interface RowModel {
  index: number;
  isMain: boolean;
  /** Display name (already resolved). */
  name: string;
  status: string;
  /** Is this row the in-view session? */
  inView: boolean;
  /** Is the ↑/↓ highlight cursor on this row? */
  highlighted: boolean;
  /** Unread/attention badge (finished while not in view, not yet viewed). */
  attention?: boolean;
  /** Short model name (e.g. "haiku"); undefined hides it. */
  modelName?: string;
  /** Context-fill percent (0-100) when running; null/undefined hides it. */
  contextPercent?: number | null;
  /** Token total; 0/undefined hides it. */
  tokens?: number;
  /** Compact metadata tail (duration/elapsed, already formatted). */
  timing?: string;
  /** Live activity string (running rows). */
  activity?: string;
}

/** Format the token + ctx% tail, e.g. "12.3k tok · 45%". */
export function formatRowTokens(tokens?: number, contextPercent?: number | null): string {
  const parts: string[] = [];
  if (tokens && tokens > 0) {
    const t = tokens >= 1_000_000
      ? `${(tokens / 1_000_000).toFixed(1)}M tok`
      : tokens >= 1_000
        ? `${(tokens / 1_000).toFixed(1)}k tok`
        : `${tokens} tok`;
    parts.push(t);
  }
  if (contextPercent != null) parts.push(`${Math.round(contextPercent)}%`);
  return parts.join(" · ");
}

/**
 * Render one session-list row to a themed string (single line).
 *
 * Layout (spec §3.4 / §7):
 *   <glyph> <name>(idx) [◀ in view] [●] <timing> · <model> · <tok/ctx> · <activity>
 *
 * - `highlighted` rows get a bold name (cursor distinction; the host also inverse-
 *   highlights via the widget, but bold keeps it distinct in plain captures/tests).
 * - `inView` rows get the persistent `◀ in view` marker in accent (spec §3.5).
 * - The two cues are independent and can appear on different rows simultaneously (FR-8).
 */
export function formatSessionRow(m: RowModel, theme: Theme): string {
  const glyph = theme.fg(glyphColor(m.status), statusGlyph(m.status));
  const nameText = `${m.name}(${m.index})`;
  const name = m.highlighted ? theme.bold(nameText) : nameText;

  const segs: string[] = [glyph, name];

  if (m.inView) segs.push(theme.fg("accent", IN_VIEW_MARKER));
  if (m.attention && !m.inView) segs.push(theme.fg("warning", "●")); // attention badge (FR-11)

  const tail: string[] = [];
  if (m.timing) tail.push(m.timing);
  if (m.modelName) tail.push(m.modelName);
  const tok = formatRowTokens(m.tokens, m.contextPercent);
  if (tok) tail.push(tok);
  if (m.activity) tail.push(m.activity);

  if (tail.length > 0) {
    segs.push(theme.fg("dim", "·"));
    segs.push(theme.fg("dim", tail.join(" · ")));
  }

  // Highlight cursor prefix: a caret so plain-text captures show the cursor row (FR-8).
  const cursor = m.highlighted ? theme.fg("accent", "›") + " " : "  ";
  return cursor + segs.join(" ");
}

/** The editor "row" indicator shown in the list when the highlight is in the editor. */
export function formatEditorCursorRow(highlighted: boolean, theme: Theme): string {
  const label = theme.fg("dim", "(editor)");
  const cursor = highlighted ? theme.fg("accent", "›") + " " : "  ";
  return cursor + label;
}

/** Fields for the in-view pane header (spec §3.1 / FR-7). */
export interface PaneHeaderModel {
  name: string;
  index: number;
  status: string;
  timing?: string;
  modelName?: string;
  contextPercent?: number | null;
  tokens?: number;
  activity?: string;
}

/**
 * One-line pane header: "in-view: Explore (2) · running 4.2s · model: haiku · ctx 31% · <activity>".
 * Guarantees model name, context %, and live activity are present when available (FR-7).
 */
export function formatPaneHeader(m: PaneHeaderModel, theme: Theme): string {
  const glyph = theme.fg(glyphColor(m.status), statusGlyph(m.status));
  const head = `${theme.fg("dim", "in-view:")} ${theme.bold(`${m.name} (${m.index})`)}`;
  const parts: string[] = [];
  if (m.timing) parts.push(m.timing);
  if (m.modelName) parts.push(`model: ${m.modelName}`);
  if (m.contextPercent != null) parts.push(`ctx ${Math.round(m.contextPercent)}%`);
  if (m.tokens && m.tokens > 0) parts.push(formatRowTokens(m.tokens, null));
  if (m.activity) parts.push(m.activity);
  const tail = parts.length > 0 ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}` : "";
  return `${glyph} ${head}${tail}`;
}

/** Breadcrumb text for setStatus (spec §3.3 / FR-3): "▸ Explore (2)" or "▸ main(0)". */
export function formatBreadcrumb(name: string, index: number, isMain: boolean): string {
  return isMain ? `▸ main(0)` : `▸ ${name} (${index})`;
}

/**
 * Compose the full vertical session list (spec §3.1, §7), top → bottom:
 *
 *   (editor)        ← cursor row when highlight is in the editor
 *   ● main(0)
 *   ● Explore(2)   ◀ in view  · …
 *   ✓ Researcher(1) · …
 *
 * `editorHighlighted` adds a leading `(editor)` cursor row so the highlight is visible
 * even when focus is in the editor (FR-8 visual distinction in plain captures).
 * Returns themed lines. `header` is an optional leading title line.
 */
export function renderSessionList(
  rows: RowModel[],
  editorHighlighted: boolean,
  theme: Theme,
  header?: string,
): string[] {
  const lines: string[] = [];
  if (header) lines.push(header);
  lines.push(formatEditorCursorRow(editorHighlighted, theme));
  for (const r of rows) lines.push(formatSessionRow(r, theme));
  return lines;
}
