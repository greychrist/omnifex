import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
    let unlistenNotification: UnlistenFn | null = null;
    let mounted = true;

    async function setup() {
      if (!mounted) return;

      // Listen for notification events from backend to update tab badges
      unlistenNotification = await listen<NotificationPayload>(
        "claude-notification",
        (event) => {
          const { tab_id } = event.payload;
          console.log('[Notifications] received claude-notification for tab:', tab_id, 'active:', activeTabIdRef.current);

          // Mark non-active tabs with unread badge
          if (tab_id !== activeTabIdRef.current) {
            console.log('[Notifications] marking tab as unread:', tab_id);
            updateTabRef.current(tab_id, { hasUnreadResult: true });
          }
        }
      );
    }

    setup().catch(console.error);

    return () => {
      mounted = false;
      if (unlistenNotification) unlistenNotification();
    };
  }, []);
}
