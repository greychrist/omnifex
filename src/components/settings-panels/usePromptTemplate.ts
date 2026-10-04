import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fireAndLog } from '@/lib/fireAndLog';
import { useSaveStatus } from './saveStatus';

/**
 * Load/edit/auto-save cycle for one prompt template stored in `app_settings`.
 *
 * Extracted from `SummaryPromptSettings` when the Compactions panel needed the
 * same behaviour: debounced auto-save with no Save button, reported through the
 * Settings save indicator, and reset-to-default. Only the storage key and the
 * default text differ between the two.
 */

/** Debounce before the textarea contents are persisted. Tuned so short pauses
 *  while typing flush, and rapid edits coalesce into one save. */
export const PROMPT_AUTOSAVE_DEBOUNCE_MS = 500;

export interface UsePromptTemplateResult {
  value: string;
  loading: boolean;
  isDefault: boolean;
  /** Update the editor and schedule a debounced save. */
  edit: (next: string) => void;
  /** Replace the editor with the shipped default and save it. */
  resetToDefault: () => void;
}

export function usePromptTemplate(
  settingKey: string,
  defaultPrompt: string,
): UsePromptTemplateResult {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const { track } = useSaveStatus();

  // Refreshed on every keystroke so the save fires after the *last* edit
  // rather than the first.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last value successfully persisted, so the autosave can no-op when the
  // editor already shows what's on disk (initial mount, undo back to saved).
  const savedRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    api
      .getSetting(settingKey)
      .then((stored) => {
        if (cancelled) return;
        // An empty stored value is indistinguishable from unset.
        const initial = stored ? stored : defaultPrompt;
        setValue(initial);
        savedRef.current = initial;
      })
      .catch(() => {
        if (cancelled) return;
        setValue(defaultPrompt);
        savedRef.current = defaultPrompt;
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // Storage key and default are module constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleAutosave = (next: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      fireAndLog('prompt-template:autosave', async () => {
        saveTimer.current = null;
        if (next === savedRef.current) return;
        if (await track(api.saveSetting(settingKey, next))) savedRef.current = next;
      }),
      PROMPT_AUTOSAVE_DEBOUNCE_MS,
    );
  };

  const edit = (next: string) => {
    setValue(next);
    scheduleAutosave(next);
  };

  const resetToDefault = () => {
    if (value === defaultPrompt) return;
    setValue(defaultPrompt);
    scheduleAutosave(defaultPrompt);
  };

  return {
    value,
    loading,
    isDefault: value === defaultPrompt,
    edit,
    resetToDefault,
  };
}
