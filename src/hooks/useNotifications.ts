import { useEffect, useLayoutEffect, useRef } from "react";

interface NotificationPayload {
  tab_id: string;
  title: string;
  body: string;
  is_error: boolean;
  origin?: string;
}

export function useNotifications(
  activeTabId: string | null,
  setActiveTab: (id: string) => void,
  updateTab: (id: string, updates: { hasUnreadResult: boolean }) => void
) {
  const activeTabIdRef = useRef(activeTabId);
  const setActiveTabRef = useRef(setActiveTab);
  const updateTabRef = useRef(updateTab);
  useLayoutEffect(() => {
    activeTabIdRef.current = activeTabId;
    setActiveTabRef.current = setActiveTab;
    updateTabRef.current = updateTab;
  });

  useEffect(() => {
    const unlistenNotification = window.electronAPI.onEvent(
      "claude-notification",
      (payload: unknown) => {
        const { tab_id, origin } = payload as NotificationPayload;
        if (origin !== 'mod' && tab_id !== activeTabIdRef.current) {
          updateTabRef.current(tab_id, { hasUnreadResult: true });
        }
      }
    );

    return () => {
      unlistenNotification();
    };
  }, []);
}
