import React from "react";
import { Card } from "@/components/ui/card";
import { HooksEditor } from "@/components/HooksEditor";

interface HooksSettingsProps {
  activeTab: string;
  onHooksChange: (hasChanges: boolean, getHooks: () => any) => void;
}

export const HooksSettings: React.FC<HooksSettingsProps> = ({
  activeTab,
  onHooksChange,
}) => {
  return (
    <Card className="p-6">
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold mb-2">User Hooks</h3>
          <p className="text-body-small text-muted-foreground mb-4">
            Configure hooks that apply to all Claude Code sessions for your user account.
            These are stored in <code className="mx-1 px-2 py-1 bg-muted rounded text-xs">~/.claude/settings.json</code>
          </p>
        </div>

        <HooksEditor
          key={activeTab}
          scope="user"
          className="border-0"
          hideActions={true}
          onChange={(hasChanges, getHooks) => {
            onHooksChange(hasChanges, getHooks);
          }}
        />
      </div>
    </Card>
  );
};
