/**
 * session-nav-controller.ts — Coordinator that owns subagent navigation state and
 * wires together the session list widget, the in-view transcript pane, key
 * interception, submit routing, and the breadcrumb (spec §5).
 *
 * State owned here:
 *  - highlightIndex (EDITOR | 0 main | 1..N subagents)  — where ↑/↓ is
 *  - inViewSessionId                                    — whose transcript renders
 *  - attentionSet                                       — finished-while-away badges
 *  - navActive                                          — whether the list is shown
 *
 * It delegates ALL decision logic to the pure modules (nav-state, input-routing,
 * session-list-model, session-row-format) and only performs side effects (setWidget /
 * custom / setStatus / steer) here. The pure pieces are unit-tested; this file is
 * exercised by the integration tests against a fake ctx.ui + fake manager.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  type AgentActivity,
  describeActivity,
  formatDuration,
  getDisplayName,
} from "./agent-widget.js";
import { TranscriptPane } from "./conversation-viewer.js";
import { disabledHint, type RoutableSession, resolveInputRoute } from "./input-routing.js";
import {
  type CaretInfo,
  EDITOR,
  type NavEffect,
  type NavKey,
  type NavState,
  resolveNavKey,
  resolveNumberJump,
} from "./nav-state.js";
import { isFinishedStatus, SessionListModel } from "./session-list-model.js";
import {
  formatBreadcrumb,
  type RowModel,
  renderSessionList,
} from "./session-row-format.js";
import type { Theme } from "./theme.js";

/** Result a terminal-input handler may return (mirrors core TerminalInputHandler). */
export type TerminalInputResult = { consume?: boolean; data?: string } | undefined;

/**
 * UI surface the controller needs — a structural subset of the core
 * ExtensionUIContext (verified against extensions/types.d.ts). `custom` is the
 * real Promise-based shape: factory `(tui, theme, keybindings, done)` and options
 * `{ overlay?, overlayOptions? }` where overlayOptions carries `nonCapturing`.
 */
export interface NavUICtx {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content:
      | undefined
      | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => TerminalInputResult): () => void;
  getEditorText(): string;
  setEditorText(text: string): void;
  custom?<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      onHandle?: (handle: unknown) => void;
    },
  ): Promise<T>;
}

/** Minimal manager surface (keeps controller decoupled / testable). */
export interface NavManager {
  listAgents(): AgentRecord[];
  getRecord(id: string): AgentRecord | undefined;
}

const WIDGET_KEY = "subagent-nav";
const STATUS_KEY = "subagent-nav-crumb";

export class SessionNavController {
  private state: NavState = { highlightIndex: EDITOR, inViewIndex: 0 };
  /** In-view session id; undefined means main(0). */
  private inViewSessionId: string | undefined;
  /** Finished-while-not-in-view ids that have not been viewed yet (FR-11). */
  private attentionSet = new Set<string>();
  /** Ids we've already seen as finished (to detect new finishes). */
  private seenFinished = new Set<string>();

  private model: SessionListModel;
  private ui: NavUICtx | undefined;
  private tui: TUI | undefined;
  private widgetRegistered = false;
  private detachInput: (() => void) | undefined;

  /** Resolves the in-flight custom() promise to tear the pane down. */
  private paneDone: (() => void) | undefined;
  private pane: TranscriptPane | undefined;

  private lastBreadcrumb: string | undefined;

  constructor(
    private manager: NavManager,
    private agentActivity: Map<string, AgentActivity>,
    /** Accessor for the live main session (for completeness / future use). */
    private getMainSession: () => AgentSession | undefined,
  ) {
    this.model = new SessionListModel(manager);
  }

  /**
   * Wire (or rewire) the UI context. Idempotent. No-ops when the UI surface lacks
   * interactive primitives (print/RPC modes have a minimal ctx.ui with no
   * onTerminalInput) — the nav UI is interactive-only.
   */
  setUICtx(ui: NavUICtx): void {
    if (ui === this.ui) return;
    if (typeof ui.onTerminalInput !== "function" || typeof ui.setWidget !== "function") {
      return; // non-interactive mode — nothing to wire
    }
    this.teardownInput();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastBreadcrumb = undefined;
    this.detachInput = ui.onTerminalInput((data) => this.onInput(data));
  }

  private teardownInput(): void {
    this.detachInput?.();
    this.detachInput = undefined;
  }

  // ---- Caret heuristic (S0.2 approach B) --------------------------------------

  /** Derive caret-boundary info from the current editor text (conservative). */
  private caretInfo(): CaretInfo {
    const text = this.ui?.getEditorText?.() ?? "";
    if (text.length === 0) return { atFirstLine: true, atLastLine: true, isEmpty: true };
    // We cannot observe the true caret line from onTerminalInput, so treat a
    // single-line buffer as both first & last, and a multi-line buffer as
    // "not at last line" until proven otherwise. This errs toward letting the
    // editor handle ↓ (never hijacks mid-text — FR-13); the user presses ↓ once
    // more at the bottom to fall through.
    const hasNewline = text.includes("\n");
    return {
      atFirstLine: !hasNewline,
      atLastLine: !hasNewline,
      isEmpty: false,
    };
  }

  // ---- Key interception -------------------------------------------------------

  /** Normalize a raw input byte-string to a NavKey, or undefined if not a nav key. */
  private toNavKey(data: string): NavKey | undefined {
    switch (data) {
      case "\x1b[A":
      case "\x1bOA":
        return "up";
      case "\x1b[B":
      case "\x1bOB":
        return "down";
      case "\x1b[C":
      case "\x1bOC":
        return "right";
      case "\x1b[D":
      case "\x1bOD":
        return "left";
      case "\r":
      case "\n":
        return "enter";
      case "\x1b":
        return "escape";
      default:
        return undefined;
    }
  }

  /** Raw terminal input handler (runs before the editor). */
  private onInput(data: string): TerminalInputResult {
    if (!this.ui) return undefined;

    // Number-key jump (0-9) only when focus is in the list (highlight >= 0).
    if (this.state.highlightIndex >= 0 && data.length === 1 && data >= "0" && data <= "9") {
      const digit = data.charCodeAt(0) - 48;
      const res = resolveNumberJump(this.state, digit, this.model.length());
      if (res.consume) {
        this.state = res.state;
        this.applyEffect(res.effect);
        this.refresh();
        return { consume: true };
      }
    }

    const key = this.toNavKey(data);
    if (!key) {
      // Non-nav key while highlight is in the list: a printable char should drop
      // focus back to the editor so typing "just works" (mirrors the editor stack).
      return undefined;
    }

    const res = resolveNavKey({
      state: this.state,
      key,
      caret: this.caretInfo(),
      listLength: this.model.length(),
    });
    this.state = res.state;
    this.applyEffect(res.effect);
    this.refresh();
    return res.consume ? { consume: true } : undefined;
  }

  private applyEffect(effect: NavEffect): void {
    switch (effect.kind) {
      case "view":
        this.setInView(effect.index);
        break;
      case "reset":
        this.setInView(0);
        this.state = { highlightIndex: EDITOR, inViewIndex: 0 };
        break;
      case "focusEditorEnd":
        // Caret is conceptually at end of text; nothing to do beyond leaving the
        // list (highlight already EDITOR). The stock editor keeps its own caret.
        break;
      default:
        break;
    }
  }

  /** Set the in-view session by list index and (re)render the pane. */
  private setInView(index: number): void {
    this.state.inViewIndex = index;
    const entry = this.model.getByIndex(index);
    if (!entry || entry.isMain) {
      this.inViewSessionId = undefined;
      this.hidePane();
      this.updateBreadcrumb();
      return;
    }
    this.inViewSessionId = entry.id;
    // Viewing clears its attention badge (FR-11).
    if (entry.id) this.attentionSet.delete(entry.id);
    this.showPane(entry.index, entry.record!);
    this.updateBreadcrumb();
  }

  // ---- Transcript pane (S0.1) -------------------------------------------------

  /**
   * Mount (or retarget) the borderless non-capturing transcript pane.
   *
   * Uses the real Promise-based `custom()` (S0.1): the factory builds a
   * TranscriptPane and we keep `done` to tear it down and the OverlayHandle to
   * toggle visibility. `nonCapturing: true` keeps keystrokes flowing to the
   * editor (verified against OverlayOptions in pi-tui). Anchored bottom-center
   * just above the editor so it fills the chat region.
   */
  private showPane(index: number, record: AgentRecord): void {
    if (!this.ui || !record.session) {
      this.hidePane();
      return;
    }
    const activity = record.id ? this.agentActivity.get(record.id) : undefined;

    // Retarget an existing pane in place (no remount) — keeps the overlay stable.
    if (this.pane && this.tui) {
      this.pane.setSession(record.session, record, activity, index);
      this.tui.requestRender?.();
      return;
    }

    if (typeof this.ui.custom !== "function") {
      // Host without custom() — degrade to no pane (list + breadcrumb still work).
      return;
    }

    const session = record.session;
    void this.ui.custom<undefined>(
      (tui, theme, _kb, done) => {
        this.tui = tui;
        this.paneDone = () => done(undefined);
        this.pane = new TranscriptPane(tui, session, record, activity, theme, index);
        return this.pane;
      },
      {
        overlay: true,
        // Anchor at the bottom edge so the pane fills the chat region directly above
        // the real input box (spec §3.1 — seamless, NOT a centered popover).
        // "bottom-center" is a valid OverlayAnchor (verified against pi-tui's
        // OverlayAnchor union). nonCapturing keeps keystrokes flowing to the editor (FR-13).
        overlayOptions: {
          nonCapturing: true,
          anchor: "bottom-center",
          width: "100%",
          maxHeight: "70%",
        },
      },
    ).then(() => {
      // Promise resolves when the overlay is dismissed (done called).
      this.pane?.dispose();
      this.pane = undefined;
      this.paneDone = undefined;
    });
  }

  private hidePane(): void {
    this.pane?.dispose();
    this.pane = undefined;
    if (this.paneDone) {
      try { this.paneDone(); } catch { /* ignore */ }
      this.paneDone = undefined;
    }
  }

  // ---- Submit routing (pi.on("input")) ---------------------------------------

  /**
   * Decide what a submitted message should do. Returns "handled" to suppress the
   * main turn (steer / disabled), or undefined to let the main session handle it.
   * Wired by index.ts to `pi.on("input", text => controller.routeInput(text))`.
   */
  routeInput(text: string): "handled" | undefined {
    const inViewIsMain = this.inViewSessionId === undefined;
    let routable: RoutableSession | undefined;
    if (this.inViewSessionId) {
      const rec = this.manager.getRecord(this.inViewSessionId);
      if (rec) {
        routable = { id: rec.id, status: rec.status, hasSession: !!rec.session };
      }
    }
    const route = resolveInputRoute(inViewIsMain, routable);

    switch (route.action) {
      case "mainTurn":
        return undefined; // do not intercept
      case "steer": {
        const rec = this.manager.getRecord(route.sessionId);
        if (rec) this.deliverSteer(rec, text);
        // Clear the editor so the steered text doesn't linger as a main draft.
        this.ui?.setEditorText?.("");
        return "handled";
      }
      case "disabled": {
        const rec = this.inViewSessionId ? this.manager.getRecord(this.inViewSessionId) : undefined;
        const idx = this.model.indexOfId(this.inViewSessionId);
        const name = rec ? getDisplayName(rec.type) : "agent";
        this.ui?.setStatus(STATUS_KEY, disabledHint(name, idx));
        return "handled";
      }
    }
  }

  /** Send a steer to a subagent, buffering on pendingSteers if the session isn't ready. */
  private deliverSteer(record: AgentRecord, text: string): void {
    if (record.session) {
      record.session.steer(text).catch(() => { /* swallow — surfaced in transcript on retry */ });
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(text);
    }
  }

  // ---- Rendering --------------------------------------------------------------

  /** Recompute attention badges and re-render the list + pane + breadcrumb. */
  refresh(): void {
    this.updateAttention();
    this.renderWidget();
    // Keep the pane pointed at the (possibly mutated) in-view record.
    if (this.inViewSessionId) {
      const entry = this.model.entries().find(e => e.id === this.inViewSessionId);
      if (entry?.record?.session && this.pane) {
        const activity = this.agentActivity.get(this.inViewSessionId);
        this.pane.setSession(entry.record.session, entry.record, activity, entry.index);
      } else if (!entry) {
        // In-view agent disappeared (pruned) — fall back to main.
        this.setInView(0);
      }
    }
    this.tui?.requestRender?.();
  }

  /** Detect agents that finished while not in view and badge them (FR-11). */
  private updateAttention(): void {
    for (const r of this.manager.listAgents()) {
      if (isFinishedStatus(r.status) && !this.seenFinished.has(r.id)) {
        this.seenFinished.add(r.id);
        if (r.id !== this.inViewSessionId) this.attentionSet.add(r.id);
      }
    }
  }

  /** Build the RowModel[] for the current list + nav state. */
  buildRows(): RowModel[] {
    const entries = this.model.entries();
    const rows: RowModel[] = [];
    for (const e of entries) {
      if (e.isMain) {
        const mainSession = this.getMainSession();
        rows.push({
          index: 0,
          isMain: true,
          name: "main",
          status: "running",
          inView: this.inViewSessionId === undefined,
          highlighted: this.state.highlightIndex === 0,
          contextPercent: mainSession ? getSessionContextPercent(mainSession as any) : null,
        });
        continue;
      }
      const rec = e.record!;
      const act = this.agentActivity.get(rec.id);
      const tokens = getLifetimeTotal(act?.lifetimeUsage ?? rec.lifetimeUsage);
      const running = rec.status === "running";
      rows.push({
        index: e.index,
        isMain: false,
        name: getDisplayName(rec.type),
        status: rec.status,
        inView: this.inViewSessionId === rec.id,
        highlighted: this.state.highlightIndex === e.index,
        attention: this.attentionSet.has(rec.id),
        modelName: rec.invocation?.modelName,
        contextPercent: running ? getSessionContextPercent(act?.session) : null,
        tokens,
        timing: formatDuration(rec.startedAt, rec.completedAt),
        activity: running && act ? describeActivity(act.activeTools, act.responseText) : undefined,
      });
    }
    return rows;
  }

  private renderWidget(): void {
    if (!this.ui) return;
    if (!this.widgetRegistered) {
      this.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: () => renderSessionList(this.buildRows(), this.state.highlightIndex === EDITOR, theme),
            invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
          };
        },
        { placement: "belowEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender?.();
    }
  }

  private updateBreadcrumb(): void {
    if (!this.ui) return;
    const idx = this.state.inViewIndex;
    const entry = this.model.getByIndex(idx);
    const isMain = !entry || entry.isMain;
    const name = entry?.record ? getDisplayName(entry.record.type) : "main";
    const crumb = formatBreadcrumb(name, idx, isMain);
    if (crumb !== this.lastBreadcrumb) {
      this.ui.setStatus(STATUS_KEY, crumb);
      this.lastBreadcrumb = crumb;
    }
  }

  /** Number-jump entry point for /agents integration (FR-9 stub scope). */
  jumpToIndex(index: number): void {
    const res = resolveNumberJump(this.state, index, this.model.length());
    if (res.consume) {
      this.state = res.state;
      this.applyEffect(res.effect);
      this.refresh();
    }
  }

  /** Test/inspection helpers. */
  getState(): Readonly<NavState> { return this.state; }
  getInViewSessionId(): string | undefined { return this.inViewSessionId; }
  getAttentionSet(): ReadonlySet<string> { return this.attentionSet; }

  dispose(): void {
    this.teardownInput();
    this.hidePane();
    if (this.ui && this.widgetRegistered) {
      this.ui.setWidget(WIDGET_KEY, undefined);
      this.ui.setStatus(STATUS_KEY, undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
