/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, formatDuration, formatSessionTokens, getDisplayName, getPromptModeLabel } from "./agent-widget.js";
import { formatPaneHeader } from "./session-row-format.js";
import { buildTranscriptLines } from "./transcript-builder.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
  ) {
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const name = getDisplayName(this.record.type);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

    lines.push(row(
      `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    const scrollPct = contentLines.length <= viewportHeight
      ? "100%"
      : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
    const footerLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
    const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");
    const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
    lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    lines.push(hrBot);

    return lines;
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    // Shared builder — single source of truth for transcript rendering (spec §5).
    return buildTranscriptLines(this.session, this.record, this.activity, this.theme, width);
  }
}

/**
 * TranscriptPane — borderless, non-capturing in-view transcript pane.
 *
 * Rendered via `ctx.ui.custom(factory, { nonCapturing: true, overlayOptions:
 * { placement: "chatArea" } })` so it fills the chat area above the REAL input box
 * without stealing keystrokes (spec §3.1, S0.1). It shares `buildTranscriptLines`
 * with the modal viewer and shows the model/ctx/activity pane header (FR-7).
 *
 * It is intentionally read-only and has NO key handling — all navigation/steering
 * is owned by the SessionNavController via onTerminalInput / pi.on("input").
 */
export class TranscriptPane implements Component {
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  /** Swapped in by the controller when the in-view session changes. */
  private session: AgentSession;
  private record: AgentRecord;
  private activity: AgentActivity | undefined;

  constructor(
    private tui: TUI,
    session: AgentSession,
    record: AgentRecord,
    activity: AgentActivity | undefined,
    private theme: Theme,
    /** List index of the in-view session (for the header). */
    private index: number,
  ) {
    this.session = session;
    this.record = record;
    this.activity = activity;
    this.subscribe();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  /** Point the pane at a different session (used when in-view changes without remount). */
  setSession(session: AgentSession, record: AgentRecord, activity: AgentActivity | undefined, index: number): void {
    this.session = session;
    this.record = record;
    this.activity = activity;
    this.index = index;
    this.subscribe();
    if (!this.closed) this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 6 || this.closed) return [];
    const th = this.theme;
    const innerW = width - 2;

    const header = formatPaneHeader(
      {
        name: getDisplayName(this.record.type),
        index: this.index,
        status: this.record.status,
        timing: formatDuration(this.record.startedAt, this.record.completedAt),
        modelName: this.record.invocation?.modelName,
        // Prefer the live activity session for ctx%, but fall back to the record's
        // own session so the header still shows context when activity isn't tracked
        // (e.g. resumed/finished agents viewed read-only).
        contextPercent: getSessionContextPercent(
          (this.activity?.session ?? this.session) as Parameters<typeof getSessionContextPercent>[0],
        ),
        tokens: getLifetimeTotal(this.activity?.lifetimeUsage ?? this.record.lifetimeUsage),
        activity:
          this.record.status === "running" && this.activity
            ? describeActivity(this.activity.activeTools, this.activity.responseText)
            : undefined,
      },
      th,
    );

    // The pane is an overlay composited OVER the live chat. pi-tui only paints the
    // columns each overlay line actually contains, so a short or empty line lets the
    // underlying main-session chat show through. To make the pane fully OPAQUE we
    // render exactly `rows` lines, each space-padded to the full width — so every cell
    // of the chat region is covered and main's transcript can never bleed through.
    const rows = Math.max(3, Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100) - 2);
    const opaque = (s: string) => truncateToWidth(s, width, "…", true); // pad=true → fill to width

    const lines: string[] = [];
    lines.push(opaque(header));
    lines.push(opaque(th.fg("dim", "─".repeat(Math.min(width, innerW)))));

    // Body: the tail of the transcript that fits the remaining rows.
    const bodyRows = Math.max(0, rows - lines.length);
    const content = buildTranscriptLines(this.session, this.record, this.activity, th, innerW);
    const visible = content.slice(Math.max(0, content.length - bodyRows));
    for (const l of visible) lines.push(opaque(" " + l));
    // Pad the unused rows with opaque blank lines so the whole region stays covered.
    while (lines.length < rows) lines.push(" ".repeat(width));
    return lines;
  }

  invalidate(): void { /* no cached state */ }

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
