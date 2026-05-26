import { api } from './api';

/**
 * Returns an `onSend` handler for `FloatingPromptInput` that injects the
 * prompt into the TUI's PTY. The text is suffixed with `\r` so Claude's
 * TUI submits the line, identical to the user pressing Enter inside the
 * terminal.
 *
 * Empty / whitespace-only prompts are no-ops. Image attachments are
 * silently dropped — the CLI's stdin reads as raw bytes and doesn't
 * accept image payloads; matching the rich-mode signature on `onSend`
 * keeps the call site identical between modes.
 */
export function createTuiPromptHandler(tabId: string) {
  return (prompt: string, _model: string, _images?: string[]): void => {
    if (!prompt.trim()) return;
    void api.tuiWrite(tabId, `${prompt}\r`);
  };
}
