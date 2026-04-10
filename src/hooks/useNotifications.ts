import { useEffect, useRef } from "react";

interface NotificationPayload {
  tab_id: string;
  title: string;
  body: string;
  is_error: boolean;
}

/**
 * Listens for claude-notification events and:
 * 1. Marks non-active tabs with hasUnreadResult for badge display
 * 2. Brings app to front when notification arrives for non-active tab
 *
 * Native OS notifications are sent from the Rust backend directly.
 */
export function useNotifications(
  activeTabId: string | null,
  setActiveTab: (id: string) => void,
  updateTab: (id: string, updates: Record<string, any>) => void
) {
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const setActiveTabRef = useRef(setActiveTab);
  setActiveTabRef.current = setActiveTab;

  const updateTabRef = useRef(updateTab);
  updateTabRef.current = updateTab;

  useEffect(() => {
    // Listen for notification events from backend to update tab badges
    const unlistenNotification = window.electronAPI.onEvent(
      "claude-notification",
      (payload: any) => {
        const { tab_id } = payload as NotificationPayload;
        // Mark non-active tabs with unread badge
        if (tab_id !== activeTabIdRef.current) {
          updateTabRef.current(tab_id, { hasUnreadResult: true });
        }
      }
    );

    return () => {
      unlistenNotification();
    };
  }, []);
}
