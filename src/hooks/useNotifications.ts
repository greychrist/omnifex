import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onAction } from "@tauri-apps/plugin-notification";
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
 * 2. Handles notification click to navigate to the correct tab
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
    let unlistenAction: (() => void) | null = null;
    let mounted = true;

    async function setup() {
      if (!mounted) return;

      // Listen for notification events from backend to update tab badges
      unlistenNotification = await listen<NotificationPayload>(
        "claude-notification",
        (event) => {
          const { tab_id } = event.payload;

          // Mark non-active tabs with unread badge
          if (tab_id !== activeTabIdRef.current) {
            updateTabRef.current(tab_id, { hasUnreadResult: true });
          }
        }
      );

      // Handle notification click — navigate to the correct tab
      const listener = await onAction((notification) => {
        const tabId =
          notification.extra && (notification.extra as Record<string, string>).tab_id;
        if (tabId) {
          setActiveTabRef.current(tabId);
          // Bring window to front
          getCurrentWindow().setFocus().catch(console.error);
        }
      });
      unlistenAction = () => listener.unregister();
    }

    setup().catch(console.error);

    return () => {
      mounted = false;
      if (unlistenNotification) unlistenNotification();
      if (unlistenAction) unlistenAction();
    };
  }, []);
}
