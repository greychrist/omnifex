import React from "react";
import { motion } from "framer-motion";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import type { PermissionRule } from "./types";

interface PermissionsSettingsProps {
  allowRules: PermissionRule[];
  denyRules: PermissionRule[];
  setAllowRules: React.Dispatch<React.SetStateAction<PermissionRule[]>>;
  setDenyRules: React.Dispatch<React.SetStateAction<PermissionRule[]>>;
}

export const PermissionsSettings: React.FC<PermissionsSettingsProps> = ({
  allowRules,
  denyRules,
  setAllowRules,
  setDenyRules,
}) => {
  const addPermissionRule = (type: "allow" | "deny") => {
    const newRule: PermissionRule = {
      id: `${type}-${Date.now()}`,
      value: "",
    };

    if (type === "allow") {
      setAllowRules(prev => [...prev, newRule]);
    } else {
      setDenyRules(prev => [...prev, newRule]);
    }
  };

  const updatePermissionRule = (type: "allow" | "deny", id: string, value: string) => {
    if (type === "allow") {
      setAllowRules(prev => prev.map(rule =>
        rule.id === id ? { ...rule, value } : rule
      ));
    } else {
      setDenyRules(prev => prev.map(rule =>
        rule.id === id ? { ...rule, value } : rule
      ));
    }
  };

  const removePermissionRule = (type: "allow" | "deny", id: string) => {
    if (type === "allow") {
      setAllowRules(prev => prev.filter(rule => rule.id !== id));
    } else {
      setDenyRules(prev => prev.filter(rule => rule.id !== id));
    }
  };

  return (
    <Card className="p-6">
      <div className="space-y-6">
        <div>
          <h3 className="text-heading-4 mb-2">Permission Rules</h3>
          <p className="text-body-small text-muted-foreground mb-4">
            Control which tools Claude Code can use without manual approval
          </p>
        </div>

        {/* Allow Rules */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-label text-green-500">Allow Rules</Label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addPermissionRule("allow")}
              className="gap-2 hover:border-green-500/50 hover:text-green-500"
            >
              <Plus className="h-3 w-3" />
              Add Rule
            </Button>
          </div>
          <div className="space-y-2">
            {allowRules.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                No allow rules configured. Claude will ask for approval for all tools.
              </p>
            ) : (
              allowRules.map((rule) => (
                <motion.div
                  key={rule.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2"
                >
                  <Input
                    placeholder="e.g., Bash(npm run test:*)"
                    value={rule.value}
                    onChange={(e) => updatePermissionRule("allow", rule.id, e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removePermissionRule("allow", rule.id)}
                    className="h-8 w-8"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </motion.div>
              ))
            )}
          </div>
        </div>

        {/* Deny Rules */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-label text-red-500">Deny Rules</Label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => addPermissionRule("deny")}
              className="gap-2 hover:border-red-500/50 hover:text-red-500"
            >
              <Plus className="h-3 w-3" />
              Add Rule
            </Button>
          </div>
          <div className="space-y-2">
            {denyRules.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                No deny rules configured.
              </p>
            ) : (
              denyRules.map((rule) => (
                <motion.div
                  key={rule.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2"
                >
                  <Input
                    placeholder="e.g., Bash(curl:*)"
                    value={rule.value}
                    onChange={(e) => updatePermissionRule("deny", rule.id, e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removePermissionRule("deny", rule.id)}
                    className="h-8 w-8"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </motion.div>
              ))
            )}
          </div>
        </div>

        <div className="pt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            <strong>Examples:</strong>
          </p>
          <ul className="text-caption text-muted-foreground space-y-1 ml-4">
            <li>• <code className="px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">Bash</code> - Allow all bash commands</li>
            <li>• <code className="px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">Bash(npm run build)</code> - Allow exact command</li>
            <li>• <code className="px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">Bash(npm run test:*)</code> - Allow commands with prefix</li>
            <li>• <code className="px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">Read(~/.zshrc)</code> - Allow reading specific file</li>
            <li>• <code className="px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400">Edit(docs/**)</code> - Allow editing files in docs directory</li>
          </ul>
        </div>
      </div>
    </Card>
  );
};
