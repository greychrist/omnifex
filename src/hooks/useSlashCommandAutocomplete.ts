import { useState, useCallback } from "react";
import { type SlashCommand } from "@/lib/api";
import { isLocalSlashCommand } from "@/lib/localSlashCommands";

interface SlashCommandAutocompleteState {
  showSlashCommandPicker: boolean;
  slashCommandQuery: string;
}

interface SlashCommandAutocompleteActions {
  handleTextChangeForSlash: (newValue: string, newCursorPosition: number, prevPrompt: string) => void;
  handleSlashCommandSelect: (
    command: SlashCommand,
    prompt: string,
    cursorPosition: number,
    setPrompt: (p: string) => void,
    textarea: HTMLTextAreaElement | null,
  ) => void;
  handleSlashCommandPickerClose: (textarea: HTMLTextAreaElement | null) => void;
}

export type SlashCommandAutocomplete = SlashCommandAutocompleteState & SlashCommandAutocompleteActions;

export interface SlashCommandAutocompleteOptions {
  onLocalCommand?: (commandId: string) => void;
}

export function useSlashCommandAutocomplete(
  opts: SlashCommandAutocompleteOptions = {},
): SlashCommandAutocomplete {
  const [showSlashCommandPicker, setShowSlashCommandPicker] = useState(false);
  const [slashCommandQuery, setSlashCommandQuery] = useState("");
  const [triggerCursorPosition, setTriggerCursorPosition] = useState(0);
  // Ref-stable so the select callback's identity survives parent renders: TabContent's inline closures caused render loops.
  const { onLocalCommand } = opts;

  const handleTextChangeForSlash = useCallback(
    (newValue: string, newCursorPosition: number, prevPrompt: string) => {
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

      // OmniFex-local commands run a handler instead of being inserted: the CLI does not know them.
      if (isLocalSlashCommand(command.id)) {
        setPrompt(`${beforeSlash}${afterCursor}`);
        setShowSlashCommandPicker(false);
        setSlashCommandQuery("");
        setTimeout(() => {
          textarea.focus();
          textarea.setSelectionRange(beforeSlash.length, beforeSlash.length);
        }, 0);
        onLocalCommand?.(command.id);
        return;
      }

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
    [onLocalCommand],
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
