import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface NotificationPayload {
  tab_id: string;
  title: string;
  body: string;
  is_error: boolean;
}

/**
 * Listens for claude-notification events and fires OS notifications
 * when the completed tab is not the currently active tab.
 */
export function useNotifications(
  activeTabId: string | null,
  setActiveTabId: (id: string) => void
) {
  // Use refs so the listener always reads current values without re-subscribing
  const activeTabIdRef = useRef(activeTabId);
  const setActiveTabIdRef = useRef(setActiveTabId);
  activeTabIdRef.current = activeTabId;
  setActiveTabIdRef.current = setActiveTabId;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let mounted = true;

    async function setup() {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      if (!granted || !mounted) return;

      unlisten = await listen<NotificationPayload>("claude-notification", (event) => {
        const { tab_id, title, body } = event.payload;

        // Only notify for non-active tabs
        if (tab_id === activeTabIdRef.current) return;

        sendNotification({ title, body: body.slice(0, 200) });

        // Switch to that tab and focus the window
        setTimeout(() => {
          setActiveTabIdRef.current(tab_id);
          getCurrentWindow().setFocus().catch(() => {});
        }, 100);
      });
    }

    setup().catch(console.error);

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, []); // Subscribe once, use refs for current values
}
