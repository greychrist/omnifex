import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fireAndLog } from '@/lib/fireAndLog';
import { useSaveStatus } from './saveStatus';

export const PROMPT_AUTOSAVE_DEBOUNCE_MS = 500;

export interface UsePromptTemplateResult {
  value: string;
  loading: boolean;
  isDefault: boolean;
  edit: (next: string) => void;
  resetToDefault: () => void;
}

export function usePromptTemplate(
  settingKey: string,
  defaultPrompt: string,
): UsePromptTemplateResult {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const { track } = useSaveStatus();

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
