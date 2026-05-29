/**
 * theme.ts — Shared minimal Theme contract used by all UI renderers.
 *
 * Extracted into its own module so pure formatter modules can import the type
 * without creating a runtime import cycle with agent-widget.ts.
 */

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};
