# Phase 0 — Technical de-risking notes (Subagent Session Navigation TUI)

Resolved against the real core API in
`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
(`@earendil-works/pi-coding-agent@0.75.5`). Every signature below was verified
against that `.d.ts`, not assumed from the spec table.

## Verified API surface (ExtensionUI)

```ts
setStatus(key, text | undefined): void
setWidget(key, factory | undefined, { placement?: "aboveEditor" | "belowEditor" }): void
setEditorComponent(factory | undefined): void          // EditorComponent
onTerminalInput(handler): () => void                   // handler => { consume?, data? } | void; runs BEFORE editor
getEditorText(): string
setEditorText(text): void
custom?(factory, {                                      // optional — may be undefined on older hosts
  overlay?: boolean,
  nonCapturing?: boolean,
  overlayOptions?: { maxHeight?, placement?: "chatArea" | "aboveEditor" | "belowEditor" },
}): (() => void) | undefined
showOverlay<T>(factory, { maxHeight? }): Promise<T>     // existing modal path
```

`EditorComponent` (custom-editor.d.ts): `render(width)`, `handleInput(data): boolean|void`,
optional `getCursorLine()`, `getLineCount()`, `setText()`, `getText()`.
`ExtensionAPI.on(event, handler)` + `session.steer(message: string): Promise<void>` confirmed.

## S0.1 — Non-capturing transcript pane above the editor

**Decision: use `ctx.ui.custom(factory, { nonCapturing: true, overlayOptions: { placement: "chatArea" } })`.**

- `custom()` with `nonCapturing: true` mounts a component into the chat region that
  renders (and live-updates via `session.subscribe()` + `tui.requestRender()`) but does
  **not** receive/steal keystrokes — exactly the seamless borderless pane the spec wants.
  Keys continue to reach the editor, satisfying FR-13.
- `placement: "chatArea"` fills the area above the real editor. The pane is hidden when
  `main(0)` is in view (we simply don't mount it), so the native chat renders normally.
- **Fallback (documented, auto-engaged at runtime):** `custom` is optional in the type
  (`custom?`). If the host does not provide it, `TranscriptPane` is shown through the
  existing `showOverlay()` modal path (the same shared builder used by `/agents`), so the
  feature degrades to the legacy popover rather than breaking. The shared
  `buildTranscriptLines()` builder backs both render paths.

## S0.2 — Caret-boundary detection

**Decision: approach (B) — heuristic in `onTerminalInput` using `getEditorText()` + a
self-tracked caret-line model — chosen as the primary implementation; approach (A)
(`setEditorComponent` wrapper) was evaluated and rejected.**

Rationale:
- Approach (A) requires replacing the stock editor via `setEditorComponent`. The exposed
  `EditorComponent` interface (custom-editor.d.ts) is minimal (`render`/`handleInput` +
  *optional* cursor helpers) and there is **no** `DefaultEditorFactory.build` instance
  handed to the factory in this host build — wrapping the stock editor would mean
  re-implementing it and would risk losing paste/history/wrapping behaviour. That is the
  exact "diverges from the stock editor" risk the spec warns about.
- Approach (B) is non-invasive: it leaves the stock editor fully intact and only *observes*
  arrow keys in `onTerminalInput` (which fires before the editor). Boundary logic is a
  **pure, unit-tested function** (`resolveNavKey` in `nav-state.ts`) fed by:
  - `getEditorText()` (authoritative current text), and
  - a conservative caret-line tracker that treats the editor as multi-line by `\n`.
- Boundary rule implemented: ↓ falls through to the list only when the editor is empty
  **or** the caret model is on the last line; ↑ from `main(0)` returns focus to the editor.
  When focus is already in the list, ↑/↓ move the highlight and ↑ off `main(0)` returns to
  the editor. ←/→ are always passed straight to the editor (never nav). This makes the
  common cases (empty box, single line, bottom-of-text) correct and never hijacks mid-text
  arrows (FR-2/FR-13). Wrapped-line edge cases degrade safely: a ↓ that the editor would
  have consumed for an internal wrapped line is only intercepted once the tracked logical
  line is the last one, so at worst the user presses ↓ once more.

## S0.3 — `pi.on("input")` + `session.steer()` round-trip

**Decision: intercept submit via `pi.on("input", handler)` and route by in-view session.**

- When the in-view session is a **running/queued/steered** subagent, the handler calls
  `record.session.steer(text)` (verified method) and returns the sentinel `"handled"` so the
  main session does **not** create a user turn. `steer()` injects the message into that
  agent's live loop; it shows up in the agent's transcript (and the live pane re-renders via
  the existing `subscribe()` hook). If the session object isn't ready yet, the message is
  buffered on `record.pendingSteers` (agent-manager already flushes these on
  `onSessionCreated`), so no steer is lost.
- When the in-view session is a **finished** subagent, the handler returns `"handled"`
  (swallowing the submit as a no-op) and surfaces the disabled hint via `setStatus`.
- When **main(0)** is in view, the handler returns `undefined` (does not intercept) →
  normal main-session turn.
- The pure decision (`mainTurn | steer | disabled`) lives in `input-routing.ts`
  (`resolveInputRoute`) and is unit-tested independent of the TUI.
