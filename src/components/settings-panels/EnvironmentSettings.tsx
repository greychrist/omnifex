import React from "react";
import { motion } from "framer-motion";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import type { EnvironmentVariable } from "./types";

interface EnvironmentSettingsProps {
  envVars: EnvironmentVariable[];
  setEnvVars: React.Dispatch<React.SetStateAction<EnvironmentVariable[]>>;
}

export const EnvironmentSettings: React.FC<EnvironmentSettingsProps> = ({
  envVars,
  setEnvVars,
}) => {
  const addEnvVar = () => {
    const newVar: EnvironmentVariable = {
      id: `env-${Date.now()}`,
      key: "",
      value: "",
    };
    setEnvVars(prev => [...prev, newVar]);
  };

  const updateEnvVar = (id: string, field: "key" | "value", value: string) => {
    setEnvVars(prev => prev.map(envVar =>
      envVar.id === id ? { ...envVar, [field]: value } : envVar
    ));
  };

  const removeEnvVar = (id: string) => {
    setEnvVars(prev => prev.filter(envVar => envVar.id !== id));
  };

  return (
    <Card className="p-6">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-heading-4">Environment Variables</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Environment variables applied to every Claude Code session
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={addEnvVar}
            className="gap-2"
          >
            <Plus className="h-3 w-3" />
            Add Variable
          </Button>
        </div>

        <div className="space-y-3">
          {envVars.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              No environment variables configured.
            </p>
          ) : (
            envVars.map((envVar) => (
              <motion.div
                key={envVar.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex items-center gap-2"
              >
                <Input
                  placeholder="KEY"
                  value={envVar.key}
                  onChange={(e) => updateEnvVar(envVar.id, "key", e.target.value)}
                  className="flex-1 font-mono text-sm"
                />
                <span className="text-muted-foreground">=</span>
                <Input
                  placeholder="value"
                  value={envVar.value}
                  onChange={(e) => updateEnvVar(envVar.id, "value", e.target.value)}
                  className="flex-1 font-mono text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeEnvVar(envVar.id)}
                  className="h-8 w-8 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </motion.div>
            ))
          )}
        </div>

        <div className="pt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            <strong>Common variables:</strong>
          </p>
          <ul className="text-caption text-muted-foreground space-y-1 ml-4">
            <li>• <code className="px-1 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">CLAUDE_CODE_ENABLE_TELEMETRY</code> - Enable/disable telemetry (0 or 1)</li>
            <li>• <code className="px-1 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">ANTHROPIC_MODEL</code> - Custom model name</li>
            <li>• <code className="px-1 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">DISABLE_COST_WARNINGS</code> - Disable cost warnings (1)</li>
          </ul>
        </div>
      </div>
    </Card>
  );
};
