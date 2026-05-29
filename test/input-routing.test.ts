import { describe, expect, it } from "vitest";
import { disabledHint, type RoutableSession, resolveInputRoute } from "../src/ui/input-routing.js";

const sess = (status: string, hasSession = true): RoutableSession => ({ id: "a1", status, hasSession });

describe("resolveInputRoute (FR-4, FR-5)", () => {
  it("main in view → mainTurn (not intercepted)", () => {
    expect(resolveInputRoute(true, undefined)).toEqual({ action: "mainTurn" });
    // even if a session is passed, inViewIsMain wins
    expect(resolveInputRoute(true, sess("running"))).toEqual({ action: "mainTurn" });
  });

  it("FR-4: running subagent in view → steer", () => {
    expect(resolveInputRoute(false, sess("running"))).toEqual({ action: "steer", sessionId: "a1" });
  });

  it("FR-4: queued and steered are also steerable", () => {
    expect(resolveInputRoute(false, sess("queued")).action).toBe("steer");
    expect(resolveInputRoute(false, sess("steered")).action).toBe("steer");
  });

  it("FR-4: steerable even when the live session object isn't ready (buffered)", () => {
    expect(resolveInputRoute(false, sess("running", false))).toEqual({ action: "steer", sessionId: "a1" });
  });

  it("FR-5: finished subagents disable input", () => {
    for (const s of ["completed", "aborted", "stopped", "error"]) {
      expect(resolveInputRoute(false, sess(s))).toEqual({ action: "disabled", reason: "finished" });
    }
  });

  it("no in-view session record → mainTurn", () => {
    expect(resolveInputRoute(false, undefined)).toEqual({ action: "mainTurn" });
  });
});

describe("disabledHint (FR-5)", () => {
  it("includes the agent name, index, and the chat-on-main guidance", () => {
    const h = disabledHint("Explore", 2);
    expect(h).toContain("Explore");
    expect(h).toContain("(2)");
    expect(h.toLowerCase()).toContain("disabled");
    expect(h).toContain("main(0)");
  });
});
