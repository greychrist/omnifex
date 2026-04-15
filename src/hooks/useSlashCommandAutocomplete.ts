import { useState, useCallback } from "react";
import { type SlashCommand } from "@/lib/api";

interface SlashCommandAutocompleteState {
  showSlashCommandPicker: boolean;
  slashCommandQuery: string;
}

interface SlashCommandAutocompleteActions {
  /** Call when text changes — detects `/` trigger and updates query. */
  handleTextChangeForSlash: (newValue: string, newCursorPosition: number, prevPrompt: string) => void;
  /** Handle a command selection from the picker. */
  handleSlashCommandSelect: (
    command: SlashCommand,
    prompt: string,
    cursorPosition: number,
    setPrompt: (p: string) => void,
    textarea: HTMLTextAreaElement | null,
  ) => void;
  /** Close the picker and reset query. */
  handleSlashCommandPickerClose: (textarea: HTMLTextAreaElement | null) => void;
}

export type SlashCommandAutocomplete = SlashCommandAutocompleteState & SlashCommandAutocompleteActions;

/**
 * useSlashCommandAutocomplete — manages the slash-command autocomplete
 * lifecycle: trigger detection, query text, selection, and close.
 *
 * The actual SlashCommandPicker UI remains a separate component; this
 * hook only manages the STATE and LOGIC that drives it.
 */
export function useSlashCommandAutocomplete(): SlashCommandAutocomplete {
  const [showSlashCommandPicker, setShowSlashCommandPicker] = useState(false);
  const [slashCommandQuery, setSlashCommandQuery] = useState("");
  // Internal cursor snapshot for query-range math
  const [triggerCursorPosition, setTriggerCursorPosition] = useState(0);

  const handleTextChangeForSlash = useCallback(
    (newValue: string, newCursorPosition: number, prevPrompt: string) => {
      // Detect `/` typed at the beginning of input or after whitespace
      if (newValue.length > prevPrompt.length && newValue[newCursorPosition - 1] === '/') {
        const isStartOfCommand =
          newCursorPosition === 1 ||
          (newCursorPosition > 1 && /\s/.test(newValue[newCursorPosition - 2]));

        if (isStartOfCommand) {
          console.log('[useSlashCommandAutocomplete] / detected for slash command');
          setShowSlashCommandPicker(true);
          setSlashCommandQuery("");
          setTriggerCursorPosition(newCursorPosition);
          return;
        }
      }

      // Update query while picker is open
      if (showSlashCommandPicker && newCursorPosition >= triggerCursorPosition) {
        let slashPosition = -1;
        for (let i = newCursorPosition - 1; i >= 0; i--) {
          if (newValue[i] === '/') {
            slashPosition = i;
            break;
          }
          if (newValue[i] === ' ' || newValue[i] === '\n') {
            break;
          }
        }

        if (slashPosition !== -1) {
          const query = newValue.substring(slashPosition + 1, newCursorPosition);
          setSlashCommandQuery(query);
        } else {
          setShowSlashCommandPicker(false);
          setSlashCommandQuery("");
        }
      }
    },
    [showSlashCommandPicker, triggerCursorPosition],
  );

  const handleSlashCommandSelect = useCallback(
    (
      command: SlashCommand,
      prompt: string,
      cursorPosition: number,
      setPrompt: (p: string) => void,
      textarea: HTMLTextAreaElement | null,
    ) => {
      if (!textarea) return;

      // Find the / position before cursor
      let slashPosition = -1;
      for (let i = cursorPosition - 1; i >= 0; i--) {
        if (prompt[i] === '/') {
          slashPosition = i;
          break;
        }
        if (prompt[i] === ' ' || prompt[i] === '\n') {
          break;
        }
      }

      if (slashPosition === -1) {
        console.error('[useSlashCommandAutocomplete] / position not found');
        return;
      }

      const beforeSlash = prompt.substring(0, slashPosition);
      const afterCursor = prompt.substring(cursorPosition);

      if (command.accepts_arguments) {
        const newPrompt = `${beforeSlash}${command.full_command} `;
        setPrompt(newPrompt);
        setShowSlashCommandPicker(false);
        setSlashCommandQuery("");

        setTimeout(() => {
          textarea.focus();
          const newCursorPos = beforeSlash.length + command.full_command.length + 1;
          textarea.setSelectionRange(newCursorPos, newCursorPos);
        }, 0);
      } else {
        const newPrompt = `${beforeSlash}${command.full_command} ${afterCursor}`;
        setPrompt(newPrompt);
        setShowSlashCommandPicker(false);
        setSlashCommandQuery("");

        setTimeout(() => {
          textarea.focus();
          const newCursorPos = beforeSlash.length + command.full_command.length + 1;
          textarea.setSelectionRange(newCursorPos, newCursorPos);
        }, 0);
      }
    },
    [],
  );

  const handleSlashCommandPickerClose = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      setShowSlashCommandPicker(false);
      setSlashCommandQuery("");
      setTimeout(() => {
        textarea?.focus();
      }, 0);
    },
    [],
  );

  return {
    showSlashCommandPicker,
    slashCommandQuery,
    handleTextChangeForSlash,
    handleSlashCommandSelect,
    handleSlashCommandPickerClose,
  };
}
