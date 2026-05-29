/**
 * transcript-builder.ts — Shared, reusable transcript line builder.
 *
 * Extracted from conversation-viewer.ts so BOTH the modal ConversationViewer
 * (used by the /agents fallback) and the borderless non-capturing TranscriptPane
 * render from the same logic (spec §5: "share the same builder").
 *
 * Pure-ish: depends only on pi-tui text helpers + the session message shape.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { type AgentActivity, describeActivity } from "./agent-widget.js";
import type { Theme } from "./theme.js";

/**
 * Build the wrapped, themed transcript lines for a session at a given inner width.
 * Mirrors the previous ConversationViewer.buildContentLines exactly so behaviour is
 * unchanged for the modal path.
 */
export function buildTranscriptLines(
  session: Pick<AgentSession, "messages">,
  record: Pick<AgentRecord, "status">,
  activity: AgentActivity | undefined,
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const th = theme;
  const messages = session.messages;
  const lines: string[] = [];

  if (messages.length === 0) {
    lines.push(th.fg("dim", "(waiting for first message...)"));
    return lines;
  }

  let needsSeparator = false;
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (!text.trim()) continue;
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(th.fg("accent", "[User]"));
      for (const line of wrapTextWithAnsi(text.trim(), width)) lines.push(line);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") {
          toolCalls.push((c as any).name ?? (c as any).toolName ?? "unknown");
        }
      }
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(th.bold("[Assistant]"));
      if (textParts.length > 0) {
        for (const line of wrapTextWithAnsi(textParts.join("\n").trim(), width)) lines.push(line);
      }
      for (const name of toolCalls) {
        lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
      }
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
      if (!truncated.trim()) continue;
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(th.fg("dim", "[Result]"));
      for (const line of wrapTextWithAnsi(truncated.trim(), width)) lines.push(th.fg("dim", line));
    } else if ((msg as any).role === "bashExecution") {
      const bash = msg as any;
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
      if (bash.output?.trim()) {
        const out = bash.output.length > 500 ? bash.output.slice(0, 500) + "... (truncated)" : bash.output;
        for (const line of wrapTextWithAnsi(out.trim(), width)) lines.push(th.fg("dim", line));
      }
    } else {
      continue;
    }
    needsSeparator = true;
  }

  // Streaming indicator for running agents.
  if (record.status === "running" && activity) {
    const act = describeActivity(activity.activeTools, activity.responseText);
    lines.push("");
    lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
  }

  return lines.map(l => truncateToWidth(l, width));
}
