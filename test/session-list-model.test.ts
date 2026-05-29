import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { isFinishedStatus, isSteerableStatus, SessionListModel } from "../src/ui/session-list-model.js";

function rec(id: string, startedAt: number, status: AgentRecord["status"] = "running"): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: id,
    status,
    toolUses: 0,
    startedAt,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  } as AgentRecord;
}

/** Mutable fake source whose listAgents() order is intentionally scrambled. */
class FakeSource {
  constructor(public records: AgentRecord[]) {}
  listAgents(): AgentRecord[] {
    // Return newest-first (mirrors AgentManager.listAgents) to prove the model
    // re-derives a STABLE spawn order regardless of input order.
    return [...this.records].sort((a, b) => b.startedAt - a.startedAt);
  }
}

describe("SessionListModel (FR-6)", () => {
  it("row 0 is always main; subagents follow in spawn order", () => {
    const src = new FakeSource([rec("b", 200), rec("a", 100), rec("c", 300)]);
    const model = new SessionListModel(src);
    const entries = model.entries();
    expect(entries[0]).toMatchObject({ index: 0, isMain: true });
    expect(entries.slice(1).map(e => e.id)).toEqual(["a", "b", "c"]); // spawn order, not list order
  });

  it("indices are STABLE — they never reshuffle when agents finish", () => {
    const a = rec("a", 100);
    const b = rec("b", 200);
    const c = rec("c", 300);
    const src = new FakeSource([a, b, c]);
    const model = new SessionListModel(src);
    expect(model.indexOfId("b")).toBe(2);

    // b finishes — still index 2, still present (FR-6 retain finished).
    b.status = "completed";
    b.completedAt = 250;
    expect(model.indexOfId("b")).toBe(2);
    expect(model.entries().find(e => e.id === "b")).toBeTruthy();
  });

  it("a newly-spawned agent appends at the next index without moving others", () => {
    const a = rec("a", 100);
    const b = rec("b", 200);
    const src = new FakeSource([a, b]);
    const model = new SessionListModel(src);
    expect(model.indexOfId("a")).toBe(1);
    expect(model.indexOfId("b")).toBe(2);

    const d = rec("d", 300);
    src.records.push(d);
    expect(model.indexOfId("a")).toBe(1); // unchanged
    expect(model.indexOfId("b")).toBe(2); // unchanged
    expect(model.indexOfId("d")).toBe(3); // appended
  });

  it("getByIndex returns the right entry (0 = main)", () => {
    const src = new FakeSource([rec("a", 100), rec("b", 200)]);
    const model = new SessionListModel(src);
    expect(model.getByIndex(0)).toMatchObject({ isMain: true });
    expect(model.getByIndex(1)?.id).toBe("a");
    expect(model.getByIndex(2)?.id).toBe("b");
    expect(model.getByIndex(9)).toBeUndefined();
  });

  it("same-millisecond spawns get a deterministic order via id tiebreak", () => {
    const src = new FakeSource([rec("z", 100), rec("a", 100)]);
    const model = new SessionListModel(src);
    expect(model.entries().slice(1).map(e => e.id)).toEqual(["a", "z"]);
  });

  it("length includes main and reflects subagent count", () => {
    const src = new FakeSource([rec("a", 100)]);
    const model = new SessionListModel(src);
    expect(model.length()).toBe(2);
  });
});

describe("status predicates", () => {
  it("isFinishedStatus", () => {
    expect(isFinishedStatus("completed")).toBe(true);
    expect(isFinishedStatus("error")).toBe(true);
    expect(isFinishedStatus("running")).toBe(false);
    expect(isFinishedStatus("queued")).toBe(false);
  });
  it("isSteerableStatus", () => {
    expect(isSteerableStatus("running")).toBe(true);
    expect(isSteerableStatus("queued")).toBe(true);
    expect(isSteerableStatus("steered")).toBe(true);
    expect(isSteerableStatus("completed")).toBe(false);
  });
});
