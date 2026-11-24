export type TabWaitingFor = 'permission' | 'question' | null;

export function deriveWaitingFor(
  pendingPermission: { toolName?: string } | null,
): TabWaitingFor {
  if (!pendingPermission) return null;
  return pendingPermission.toolName === 'AskUserQuestion' ? 'question' : 'permission';
}
