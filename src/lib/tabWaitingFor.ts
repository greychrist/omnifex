/**
 * Pure derivation: which "waiting for human input" state a chat session is
 * in, given its current pending permission (if any). Surfaces in the
 * TabStatusPopover as "Permission Request" / "Question Waiting" so users
 * can tell at a glance which background tab needs them.
 *
 * AskUserQuestion is the SDK's built-in question tool. It rides the same
 * canUseTool channel as Bash / Read / etc., but the right UX framing is a
 * question, not a permission grant — hence the distinct label.
 */
export type TabWaitingFor = 'permission' | 'question' | null;

export function deriveWaitingFor(
  pendingPermission: { toolName?: string } | null,
): TabWaitingFor {
  if (!pendingPermission) return null;
  return pendingPermission.toolName === 'AskUserQuestion' ? 'question' : 'permission';
}
