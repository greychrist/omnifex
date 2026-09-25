import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { EMPTY_SIDE_CHAT, type SideChat } from '@/lib/sideChat';

/**
 * The session's side chat (the CLI's `/btw`). The thread is owned by the
 * session in main and pushed as full snapshots on `session-side-chat:<tabId>`;
 * this mirrors it, seeding once so a reload or a second client picks up a
 * thread already in progress.
 */
export function useSideChat(tabId: string) {
  const [sideChat, setSideChat] = useState<SideChat>(EMPTY_SIDE_CHAT);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const unlisten = window.electronAPI.onEvent(`session-side-chat:${tabId}`, (payload: unknown) => {
      setSideChat((payload as SideChat | null) ?? EMPTY_SIDE_CHAT);
    });
    api.sessionGetSideChat(tabId)
      .then((s) => { if (live && s) setSideChat(s); })
      .catch(() => { /* no session yet — stays empty */ });
    return () => { live = false; unlisten(); };
  }, [tabId]);

  const ask = useCallback(async (question: string): Promise<boolean> => {
    const res = await api.sessionSideChatAsk(tabId, question);
    setAskError(res.ok ? null : res.error);
    return res.ok;
  }, [tabId]);

  const close = useCallback(() => {
    setAskError(null);
    void api.sessionSideChatClose(tabId);
  }, [tabId]);

  return { sideChat, askError, ask, close };
}
