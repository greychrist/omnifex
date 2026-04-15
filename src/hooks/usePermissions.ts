import { useState } from "react";
import { api } from "@/lib/api";

export interface PendingToolUse {
  name: string;
  input: Record<string, any>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  suggestions: Array<{
    type: string;
    rules?: Array<{ toolName: string; ruleContent?: string }>;
    behavior?: string;
    destination?: string;
  }>;
}

interface UsePermissionsReturn {
  waitingForPermission: boolean;
  setWaitingForPermission: React.Dispatch<React.SetStateAction<boolean>>;
  pendingToolUse: PendingToolUse | null;
  setPendingToolUse: React.Dispatch<React.SetStateAction<PendingToolUse | null>>;
  pendingRequestId: string | null;
  setPendingRequestId: React.Dispatch<React.SetStateAction<string | null>>;
  autoAllowEnabled: boolean;
  setAutoAllowEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  autoAllowedTools: Set<string>;
  setAutoAllowedTools: React.Dispatch<React.SetStateAction<Set<string>>>;
  handlePermissionAllow: (
    tabId: string,
    selectedSuggestions: any[],
    lastMessageTimeRef: React.MutableRefObject<number>,
  ) => void;
  handlePermissionDeny: (
    tabId: string,
    lastMessageTimeRef: React.MutableRefObject<number>,
  ) => void;
}

export function usePermissions(): UsePermissionsReturn {
  const [waitingForPermission, setWaitingForPermission] = useState(false);
  const [pendingToolUse, setPendingToolUse] = useState<PendingToolUse | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [autoAllowEnabled, setAutoAllowEnabled] = useState(false);
  const [autoAllowedTools, setAutoAllowedTools] = useState<Set<string>>(new Set());

  const handlePermissionAllow = (
    tabId: string,
    selectedSuggestions: any[],
    lastMessageTimeRef: React.MutableRefObject<number>,
  ) => {
    if (!pendingRequestId) return;
    api
      .respondPermission(
        tabId,
        pendingRequestId,
        "allow",
        undefined,
        selectedSuggestions.length > 0 ? selectedSuggestions : undefined,
      )
      .catch(console.error);
    setWaitingForPermission(false);
    setPendingToolUse(null);
    setPendingRequestId(null);
    // Reset inactivity timer — tool execution after permission may take time
    lastMessageTimeRef.current = Date.now();
  };

  const handlePermissionDeny = (
    tabId: string,
    lastMessageTimeRef: React.MutableRefObject<number>,
  ) => {
    if (!pendingRequestId) return;
    api.respondPermission(tabId, pendingRequestId, "deny").catch(console.error);
    setWaitingForPermission(false);
    setPendingToolUse(null);
    setPendingRequestId(null);
    // Reset inactivity timer
    lastMessageTimeRef.current = Date.now();
  };

  return {
    waitingForPermission,
    setWaitingForPermission,
    pendingToolUse,
    setPendingToolUse,
    pendingRequestId,
    setPendingRequestId,
    autoAllowEnabled,
    setAutoAllowEnabled,
    autoAllowedTools,
    setAutoAllowedTools,
    handlePermissionAllow,
    handlePermissionDeny,
  };
}
