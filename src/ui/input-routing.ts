/**
 * input-routing.ts — Pure resolver for where a submitted message should go.
 *
 * Routing follows the in-view session (spec §3.3):
 *  - main(0)                              → mainTurn  (do NOT intercept)
 *  - subagent running/queued/steered      → steer     (session.steer + suppress main)
 *  - subagent finished (completed/aborted/stopped/error) → disabled (no-op + hint)
 *
 * Free of TUI deps so it is unit-testable.
 */

import { isSteerableStatus } from "./session-list-model.js";

export type InputRoute =
  | { action: "mainTurn" }
  | { action: "steer"; sessionId: string }
  | { action: "disabled"; reason: "finished" }
  | { action: "disabled"; reason: "no-session" };

/** Minimal record shape needed to decide routing. */
export interface RoutableSession {
  id: string;
  status: string;
  /** Whether the underlying live session object exists yet. */
  hasSession: boolean;
}

/**
 * Decide the route for a submit.
 *
 * @param inViewIsMain  true when main(0) is the in-view session.
 * @param session       the in-view subagent record (ignored if inViewIsMain).
 */
export function resolveInputRoute(
  inViewIsMain: boolean,
  session: RoutableSession | undefined,
): InputRoute {
  if (inViewIsMain || !session) {
    return { action: "mainTurn" };
  }
  if (isSteerableStatus(session.status)) {
    // Steerable even if the live session object isn't ready yet — the message is
    // buffered onto pendingSteers by the manager and flushed on session creation.
    return { action: "steer", sessionId: session.id };
  }
  return { action: "disabled", reason: "finished" };
}

/** The disabled-input hint surfaced when a finished subagent is in view (FR-5). */
export function disabledHint(displayName: string, index: number): string {
  return `[${displayName} (${index}) · ✓ finished]  input disabled — Enter on main(0) to chat`;
}
