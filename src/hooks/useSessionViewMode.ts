import { useEffect, useRef, useState } from 'react';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import type { ViewMode } from '@/lib/messageRenderingConfig';

/**
 * A session's chat format: it opens in the default from Appearance › All
 * cards, and from then on is the session's own.
 *
 * Settings load asynchronously, so a session mounted before they arrive
 * starts on the built-in default and takes the saved one when it lands —
 * unless a format was picked in the meantime. A later change to the setting
 * leaves open sessions where they are; it is a default, not a switch.
 */
export function useSessionViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const { config, loaded } = useMessageRenderingConfig();
  const [viewMode, setViewModeState] = useState<ViewMode>(config.defaultViewMode);
  // Settled once the saved default has been applied or the user has chosen.
  const settledRef = useRef(loaded);

  useEffect(() => {
    if (!loaded || settledRef.current) return;
    settledRef.current = true;
    setViewModeState(config.defaultViewMode);
  }, [loaded, config.defaultViewMode]);

  const setViewMode = (mode: ViewMode) => {
    settledRef.current = true;
    setViewModeState(mode);
  };
  return [viewMode, setViewMode];
}
