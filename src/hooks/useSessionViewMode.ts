import { useEffect, useRef, useState } from 'react';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import type { ViewMode } from '@/lib/messageRenderingConfig';

/** Settings load async: a session mounted earlier takes the saved default when it lands, unless a format was picked meanwhile. */
export function useSessionViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const { config, loaded } = useMessageRenderingConfig();
  const [viewMode, setViewModeState] = useState<ViewMode>(config.defaultViewMode);
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
