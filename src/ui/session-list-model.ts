/**
 * session-list-model.ts — Pure, TUI-free model of the navigable session list.
 *
 * The list is a vertical stack: row 0 is always `main`, rows 1..N are every
 * subagent in STABLE spawn order (earliest spawn = index 1). Finished agents are
 * retained — indices never reshuffle as agents finish (spec §3.4, decision Q4).
 *
 * This module owns the index assignment so both the widget renderer and the nav
 * controller agree on what `getByIndex(n)` means. It is deliberately free of any
 * pi-tui / pi-coding-agent UI dependency so it is unit-testable headlessly.
 */

import type { AgentRecord, SubagentType } from "../types.js";

/** Status values that mean the agent is no longer doing work. */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "aborted",
  "stopped",
  "error",
  "steered",
]);

/** Status values that accept steering input (running loop). */
export const STEERABLE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "queued",
  "steered",
]);

/** Is this agent finished (no longer running/queued)? `steered` counts as finished-ish
 *  for the LIST badge purposes but is still steerable; see STEERABLE_STATUSES. */
export function isFinishedStatus(status: string): boolean {
  return status === "completed" || status === "aborted" || status === "stopped" || status === "error";
}

/** Can this session accept a steer() message right now? */
export function isSteerableStatus(status: string): boolean {
  return STEERABLE_STATUSES.has(status);
}

/** One entry in the navigable list. Index 0 is always main. */
export interface SessionListEntry {
  /** Stable list index. 0 = main, 1.. = subagents in spawn order. */
  index: number;
  /** true for the synthetic main(0) row. */
  isMain: boolean;
  /** Agent id for subagents; undefined for main. */
  id?: string;
  /** Underlying record for subagents; undefined for main. */
  record?: AgentRecord;
}

/** Minimal shape the model needs from an agent manager (keeps the model decoupled). */
export interface AgentListSource {
  /** All agent records (any order). */
  listAgents(): AgentRecord[];
}

/**
 * SessionListModel — assigns and remembers stable spawn-ordered indices.
 *
 * Spawn order is derived from each record's `startedAt` (monotonic at spawn) with
 * the record `id` as a tiebreaker so two agents started in the same millisecond
 * still get a deterministic, stable order. Once an id has been assigned a slot it
 * keeps that slot for the life of the model, even after the agent finishes or is
 * pruned and re-added (best-effort: pruned ids are forgotten on `forget`).
 */
export class SessionListModel {
  /** id -> stable spawn ordinal (1-based; assigned in first-seen spawn order). */
  private ordinal = new Map<string, number>();
  /** Next ordinal to hand out. */
  private nextOrdinal = 1;

  constructor(private source: AgentListSource) {}

  /** Ensure every currently-known agent has a stable ordinal, assigned in spawn order. */
  private sync(): void {
    const records = this.source.listAgents();
    // Sort the *unassigned* ones by spawn order so first spawn gets the lowest ordinal.
    const unseen = records
      .filter(r => !this.ordinal.has(r.id))
      .sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of unseen) {
      this.ordinal.set(r.id, this.nextOrdinal++);
    }
  }

  /** Drop bookkeeping for ids that no longer exist (e.g. after clearCompleted). */
  forgetMissing(): void {
    const live = new Set(this.source.listAgents().map(r => r.id));
    for (const id of [...this.ordinal.keys()]) {
      if (!live.has(id)) this.ordinal.delete(id);
    }
  }

  /**
   * Build the current ordered list: main(0) then subagents by stable ordinal.
   * Finished agents are included. Indices are contiguous 0..N over what is present.
   */
  entries(): SessionListEntry[] {
    this.sync();
    const records = this.source.listAgents();
    const byId = new Map(records.map(r => [r.id, r] as const));

    // Sort present records by their stable ordinal.
    const present = [...byId.values()].sort((a, b) => {
      const oa = this.ordinal.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const ob = this.ordinal.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return oa - ob;
    });

    const list: SessionListEntry[] = [{ index: 0, isMain: true }];
    let i = 1;
    for (const r of present) {
      list.push({ index: i, isMain: false, id: r.id, record: r });
      i++;
    }
    return list;
  }

  /** Number of rows (main + subagents). Always >= 1. */
  length(): number {
    return this.entries().length;
  }

  /** Get the entry at a given list index, or undefined if out of range. */
  getByIndex(index: number): SessionListEntry | undefined {
    if (index < 0) return undefined;
    return this.entries().find(e => e.index === index);
  }

  /** Find the list index currently occupied by a given session id (or 0 for main). */
  indexOfId(id: string | undefined): number {
    if (!id) return 0;
    const entry = this.entries().find(e => e.id === id);
    return entry ? entry.index : 0;
  }
}

/** Display name resolver injected so the model stays free of registry imports in tests. */
export type DisplayNameFn = (type: SubagentType) => string;
