import { useState } from "react";
import { api } from "@/lib/api";
import type {
  PermissionRequestPayload,
  PermissionSuggestion,
} from "@/lib/types/permissionRequest";

interface UsePermissionsReturn {
  /**
   * The currently-shown permission request, or null when none is open.
   * `waitingForPermission` is just `pendingPermission !== null`.
   */
  pendingPermission: PermissionRequestPayload | null;
  setPendingPermission: React.Dispatch<
    React.SetStateAction<PermissionRequestPayload | null>
  >;
  waitingForPermission: boolean;
  handlePermissionAllow: (
    tabId: string,
    selectedSuggestions: PermissionSuggestion[],
  ) => void;
  handlePermissionDeny: (tabId: string) => void;
  /**
   * Allow the pending tool call but rewrite its input first. Used by the
   * AskUserQuestion card to inject the user's selected answers as the
   * tool's effective input — the SDK's runtime then surfaces them as the
   * tool's output (`AskUserQuestionOutput.answers`).
   */
  handlePermissionAllowWithInput: (
    tabId: string,
    updatedInput: Record<string, unknown>,
  ) => void;
}

export function usePermissions(): UsePermissionsReturn {
  const [pendingPermission, setPendingPermission] =
    useState<PermissionRequestPayload | null>(null);

  const handlePermissionAllow = (
    tabId: string,
    selectedSuggestions: PermissionSuggestion[],
  ) => {
    if (!pendingPermission) return;
    api
      .respondPermission(
        tabId,
        pendingPermission.requestId,
        "allow",
        undefined,
        selectedSuggestions.length > 0 ? selectedSuggestions : undefined,
      )
      .catch(console.error);
    setPendingPermission(null);
  };

  const handlePermissionDeny = (tabId: string) => {
    if (!pendingPermission) return;
    api
      .respondPermission(tabId, pendingPermission.requestId, "deny")
      .catch(console.error);
    setPendingPermission(null);
  };

  const handlePermissionAllowWithInput = (
    tabId: string,
    updatedInput: Record<string, unknown>,
  ) => {
    if (!pendingPermission) return;
    api
      .respondPermission(
        tabId,
        pendingPermission.requestId,
        "allow",
        updatedInput,
        undefined,
      )
      .catch(console.error);
    setPendingPermission(null);
  };

  return {
    pendingPermission,
    setPendingPermission,
    waitingForPermission: pendingPermission !== null,
    handlePermissionAllow,
    handlePermissionDeny,
    handlePermissionAllowWithInput,
  };
}
