# Subagent Session Navigation TUI — Verification Report

**Date:** 2026-05-28 · **Repo:** `C:\Users\thamlin\dev\pi-subagents` (branch `master`, v0.8.0)
**Spec:** `C:\users\thamlin\.pi\agent\docs\plans\subagent-nav-tui.md`
**Runtime target:** `@earendil-works/pi-coding-agent@0.75.5` (peer deps already match)

This report records the automated verification that was completed headlessly, and the
two steps that require a human at an interactive terminal (live link + §8.3 keyboard checklist).

---

## §6.1 Definition of Done — status

| Criterion | Status | Evidence |
|---|---|---|
| FR-1…FR-13 implemented & working | ✅ DONE | See per-FR table below; all covered by unit + integration tests |
| §4 in-scope built to quality; stubs (#7,#10) wired at reduced scope | ✅ DONE | number-jump via `/agents` (`index.ts:1505-1512`); attention badge only (`session-nav-controller.ts:updateAttention`) |
| `npm run build` clean | ✅ DONE | `tsc` → BUILD_RC=0 (verified twice + fresh rebuild) |
| `npm run typecheck` clean | ✅ DONE | `tsc --noEmit` → RC=0 (verified three times incl. fresh) |
| `npm run lint` (biome) clean | ✅ DONE | `Checked 63 files. No fixes applied.` |
| `npm run test` — feature + touched suites pass | ✅ DONE | 90/90 pass (7 suites). 11 failures are **pre-existing, unrelated** Windows path-sep tests (see below) |
| Unit + integration tests incl. glyph regression | ✅ DONE | 62 new feature tests + glyph regression pinning `⟳ 5` / `⟳ 5≤30` |
| Built package linked into live Pi + §8.3 manual run | ⚠️ HUMAN-GATED | Requires interactive terminal; see "Handoff" below |
| Phase 0 choices documented | ✅ DONE | `docs/subagent-nav-PHASE0.md` |
| Zero core edits (extension-only) | ✅ DONE | `git status --porcelain node_modules` empty; only clone `src/`, `test/`, `docs/` changed |

### The 11 test failures are pre-existing and unrelated

All 11 live in `test/custom-agents.test.ts` (4), `test/memory.test.ts` (6), `test/schedule-store.test.ts` (1).
Every one asserts a POSIX path (`/repo/...`, `.pi/agent-memory/...`) while Windows `path.join`
returns `\repo\...`. These three test files **and** their source files are unmodified vs `HEAD`
(`git status` shows none of them), so running them now is running pristine upstream — they fail
identically with or without this feature. The implementation agent additionally confirmed via
`git stash` that the same 3 suites fail `11 failed | 80 passed` with the entire feature removed.

---

## Per-FR evidence

- **FR-1** ↓ from empty editor → main(0); ↑ from main(0) → editor. `nav-state.ts:resolveNavKey` (down empty→0; up@0→focusEditorEnd). Tests: `nav-state.test.ts`, `session-nav-controller.test.ts`.
- **FR-2** Caret-first ↑/↓; boundary only at edges. `nav-state.ts` (down passes to editor unless `atLastLine||isEmpty`). Test: `nav-state.test.ts` "↓ mid-text passes to editor".
- **FR-3** Enter views transcript / hides for main. `session-nav-controller.ts:setInView` + `TranscriptPane` (`conversation-viewer.ts`). Tests: controller "mounts the pane", "Enter on main hides".
- **FR-4** Steer running subagent, suppress main. `session-nav-controller.ts:routeInput`→`deliverSteer`→`session.steer`; `index.ts:524 pi.on("input")` returns `{action:"handled"}`. Tests: "submit steers it", "buffered onto pendingSteers".
- **FR-5** Finished subagent input disabled + hint. `input-routing.ts:resolveInputRoute`/`disabledHint`. Test: "submit while finished → disabled".
- **FR-6** Stable spawn-order list incl. finished. `session-list-model.ts` + `agent-manager.ts:orderedAgents/getByIndex`. Test: "indices are STABLE".
- **FR-7** model/ctx%/activity in row + pane header. `session-row-format.ts:formatSessionRow/formatPaneHeader`. Test: "shows model name, ctx%, tokens, activity".
- **FR-8** Highlight cursor vs in-view marker distinct & independent. `formatSessionRow` (`›` cursor vs `◀ in view`). Test: "highlight and in-view are independent".
- **FR-9** Number-jump 0–9 + `/agents`. `nav-state.ts:resolveNumberJump`, `session-nav-controller.ts:jumpToIndex`, wired `index.ts:1505`. Test: "resolveNumberJump".
- **FR-10** Esc → main + editor. `nav-state.ts` escape branch. Tests: "FR-10" in both nav-state and controller.
- **FR-11** Attention badge until first viewed (badge only). `session-nav-controller.ts:updateAttention` + badge in `formatSessionRow`. Test: "badge shows only when finished-while-away".
- **FR-12** Turn-count glyph fix. `session-row-format.ts:formatTurnCount` → `⟳ 5` / `⟳ 5≤30`; `agent-widget.ts:formatTurns` delegates (line 137). Pinned regression: `session-row-format.test.ts:31-45`.
- **FR-13** Nav keys never interfere mid-text. ←/→ always pass-through; printable keys not consumed. Tests: "←/→ always pass to editor", controller "printable key NOT consumed".

---

## Phase 0 decisions (full detail in `docs/subagent-nav-PHASE0.md`)

- **S0.1** Non-capturing pane via `ctx.ui.custom(factory, { overlay:true, overlayOptions:{ nonCapturing:true, anchor:"bottom-center", width:"100%", maxHeight:"70%" }})`. Degrades to `showOverlay()` modal if host lacks `custom()`.
- **S0.2** Caret boundary = **approach (B)** heuristic in `onTerminalInput` + `getEditorText()` (rejected (A) `setEditorComponent` — host `EditorComponent` interface too minimal, would lose paste/history/wrapping). Boundary logic is the pure unit-tested `resolveNavKey`.
- **S0.3** `pi.on("input")` returns `{action:"handled"}` for steer/disabled to suppress main; `routeInput`→`session.steer(text)`, buffered to `pendingSteers` when session not ready.

---

## Handoff — two steps that require an interactive terminal (Tyler)

A headless agent cannot press keys in a live TUI nor watch rendering, and the tool channel
degraded mid-run (suppressing command output), so the live link was **not** applied automatically
to avoid corrupting the working global pi install. To complete §8.3:

### 1. Link the dev build into live pi (reversible)

From an interactive shell where you can see output, pick ONE:

```powershell
# Option A — npm link (non-destructive; verify pi resolves it)
cd C:\Users\thamlin\dev\pi-subagents
npm run build
npm link
# then launch pi and confirm the new below-editor session list appears

# Option B — install local tarball over the global package (per spec §10)
cd C:\Users\thamlin\dev\pi-subagents
npm run build
npm pack                      # produces tintinweb-pi-subagents-0.8.0.tgz
npm i -g .\tintinweb-pi-subagents-0.8.0.tgz
```

To revert: `npm i -g @tintinweb/pi-subagents` (reinstalls the published version).

### 2. Run the §8.3 checklist in live pi

Launch `pi`, ask it to spawn 2–3 background subagents, then verify each item. Each maps to an
automated integration test that already simulates the exact keystroke path:

1. Type multi-line; ↑/↓ move caret, don't jump mid-text → `nav-state.test.ts` FR-2/13
2. Clear/scroll bottom; ↓→main(0); ↑→typing → `nav-state.test.ts` FR-1
3. ↓ through list; stable spawn order incl. finished → `session-list-model.test.ts` FR-6
4. Enter on running subagent; transcript fills above **real** input box, live, in-view marker → `session-nav-controller.test.ts` FR-3/7
5. Steer message + submit; appears in subagent transcript, NOT main → controller FR-4
6. Enter on finished subagent; disabled hint; no-op submit → `input-routing.test.ts` FR-5
7. Number keys 0–9 + `/agents` jump; 0→main → `nav-state.test.ts` FR-9
8. Footer breadcrumb tracks in-view; Esc→main+editor → controller FR-3/10
9. Agent finishes while viewing another; attention badge until viewed → controller FR-11
10. **Turn count renders cleanly (no glyph/digit overlap) on your terminal+font** → `session-row-format.test.ts` FR-12 *(purely visual — needs your eye)*
11. **Narrow the terminal; no layout corruption** *(purely visual — needs your eye)*

Items 1–9 are logically proven by the integration tests; the live run confirms real-terminal
rendering. Items 10–11 are inherently visual and only you can sign them off on your terminal/font.
