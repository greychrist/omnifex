import React, { useState } from "react";
import { Plus, Terminal, Globe, Trash2, Info } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SelectComponent } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { fireAndLog } from "@/lib/fireAndLog";

interface MCPAddServerProps {
  onServerAdded: () => void;
  onError: (message: string) => void;
  configDir?: string;
}

interface EnvironmentVariable {
  id: string;
  key: string;
  value: string;
}

export const MCPAddServer: React.FC<MCPAddServerProps> = ({
  onServerAdded,
  onError,
  configDir,
}) => {
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [saving, setSaving] = useState(false);

  const [stdioName, setStdioName] = useState("");
  const [stdioCommand, setStdioCommand] = useState("");
  const [stdioArgs, setStdioArgs] = useState("");
  const [stdioScope, setStdioScope] = useState("local");
  const [stdioEnvVars, setStdioEnvVars] = useState<EnvironmentVariable[]>([]);
  
  const [sseName, setSseName] = useState("");
  const [sseUrl, setSseUrl] = useState("");
  const [sseScope, setSseScope] = useState("local");
  const [sseEnvVars, setSseEnvVars] = useState<EnvironmentVariable[]>([]);

  const addEnvVar = (type: "stdio" | "sse") => {
    const newVar: EnvironmentVariable = {
      id: `env-${Date.now()}`,
      key: "",
      value: "",
    };
    
    if (type === "stdio") {
      setStdioEnvVars(prev => [...prev, newVar]);
    } else {
      setSseEnvVars(prev => [...prev, newVar]);
    }
  };

  const updateEnvVar = (type: "stdio" | "sse", id: string, field: "key" | "value", value: string) => {
    if (type === "stdio") {
      setStdioEnvVars(prev => prev.map(v => 
        v.id === id ? { ...v, [field]: value } : v
      ));
    } else {
      setSseEnvVars(prev => prev.map(v => 
        v.id === id ? { ...v, [field]: value } : v
      ));
    }
  };

  const removeEnvVar = (type: "stdio" | "sse", id: string) => {
    if (type === "stdio") {
      setStdioEnvVars(prev => prev.filter(v => v.id !== id));
    } else {
      setSseEnvVars(prev => prev.filter(v => v.id !== id));
    }
  };

  const handleAddStdioServer = async () => {
    if (!stdioName.trim()) {
      onError("Server name is required");
      return;
    }
    
    if (!stdioCommand.trim()) {
      onError("Command is required");
      return;
    }
    
    try {
      setSaving(true);
      
      const args = stdioArgs.trim() ? stdioArgs.split(/\s+/) : [];
      
      const env = stdioEnvVars.reduce<Record<string, string>>((acc, { key, value }) => {
        if (key.trim() && value.trim()) {
          acc[key] = value;
        }
        return acc;
      }, {});
      
      const result = await api.mcpAdd(
        stdioName,
        "stdio",
        stdioCommand,
        args,
        env,
        undefined,
        stdioScope,
        configDir
      );
      
      if (result.success) {
        setStdioName("");
        setStdioCommand("");
        setStdioArgs("");
        setStdioEnvVars([]);
        setStdioScope("local");
        onServerAdded();
      } else {
        onError(result.message);
      }
    } catch (error) {
      onError("Failed to add server");
      console.error("Failed to add stdio server:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleAddSseServer = async () => {
    if (!sseName.trim()) {
      onError("Server name is required");
      return;
    }
    
    if (!sseUrl.trim()) {
      onError("URL is required");
      return;
    }
    
    try {
      setSaving(true);
      
      const env = sseEnvVars.reduce<Record<string, string>>((acc, { key, value }) => {
        if (key.trim() && value.trim()) {
          acc[key] = value;
        }
        return acc;
      }, {});
      
      const result = await api.mcpAdd(
        sseName,
        "sse",
        undefined,
        [],
        env,
        sseUrl,
        sseScope,
        configDir
      );
      
      if (result.success) {
        setSseName("");
        setSseUrl("");
        setSseEnvVars([]);
        setSseScope("local");
        onServerAdded();
      } else {
        onError(result.message);
      }
    } catch (error) {
      onError("Failed to add server");
      console.error("Failed to add SSE server:", error);
    } finally {
      setSaving(false);
    }
  };

  const renderEnvVars = (type: "stdio" | "sse", envVars: EnvironmentVariable[]) => {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Environment Variables</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { addEnvVar(type); }}
            className="gap-2"
          >
            <Plus className="h-3 w-3" />
            Add Variable
          </Button>
        </div>
        
        {envVars.length > 0 && (
          <div className="space-y-2">
            {envVars.map((envVar) => (
              <div key={envVar.id} className="flex items-center gap-2">
                <Input
                  placeholder="KEY"
                  value={envVar.key}
                  onChange={(e) => { updateEnvVar(type, envVar.id, "key", e.target.value); }}
                  className="flex-1 font-mono text-sm"
                />
                <span className="text-muted-foreground">=</span>
                <Input
                  placeholder="value"
                  value={envVar.value}
                  onChange={(e) => { updateEnvVar(type, envVar.id, "value", e.target.value); }}
                  className="flex-1 font-mono text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => { removeEnvVar(type, envVar.id); }}
                  className="h-8 w-8 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-base font-semibold">Add MCP Server</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Configure a new Model Context Protocol server
        </p>
      </div>

      <Tabs value={transport} onValueChange={(v) => { setTransport(v as "stdio" | "sse"); }}>
        <TabsList className="grid w-full grid-cols-2 max-w-sm mb-6">
          <TabsTrigger value="stdio" className="gap-2">
            <Terminal className="h-4 w-4 text-amber-500" />
            Stdio
          </TabsTrigger>
          <TabsTrigger value="sse" className="gap-2">
            <Globe className="h-4 w-4 text-emerald-500" />
            SSE
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stdio" className="space-y-6">
          <Card className="p-6 space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="stdio-name">Server Name</Label>
                <Input
                  id="stdio-name"
                  placeholder="my-server"
                  value={stdioName}
                  onChange={(e) => { setStdioName(e.target.value); }}
                />
                <p className="text-xs text-muted-foreground">
                  A unique name to identify this server
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="stdio-command">Command</Label>
                <Input
                  id="stdio-command"
                  placeholder="/path/to/server"
                  value={stdioCommand}
                  onChange={(e) => { setStdioCommand(e.target.value); }}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  The command to execute the server
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="stdio-args">Arguments (optional)</Label>
                <Input
                  id="stdio-args"
                  placeholder="arg1 arg2 arg3"
                  value={stdioArgs}
                  onChange={(e) => { setStdioArgs(e.target.value); }}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Space-separated command arguments
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="stdio-scope">Scope</Label>
                <SelectComponent
                  value={stdioScope}
                  onValueChange={(value: string) => { setStdioScope(value); }}
                  options={[
                    { value: "local", label: "Local (this project only)" },
                    { value: "project", label: "Project (shared via .mcp.json)" },
                    { value: "user", label: "User (all projects)" },
                  ]}
                />
              </div>

              {renderEnvVars("stdio", stdioEnvVars)}
            </div>

            <div className="pt-2">
              <Button
                onClick={fireAndLog('mcpadd-server:click', handleAddStdioServer)}
                disabled={saving}
                className="w-full gap-2 bg-primary hover:bg-primary/90"
              >
                {saving ? (
                  <>
                    <Spinner />
                    Adding Server...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Add Stdio Server
                  </>
                )}
              </Button>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="sse" className="space-y-6">
          <Card className="p-6 space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="sse-name">Server Name</Label>
                <Input
                  id="sse-name"
                  placeholder="sse-server"
                  value={sseName}
                  onChange={(e) => { setSseName(e.target.value); }}
                />
                <p className="text-xs text-muted-foreground">
                  A unique name to identify this server
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sse-url">URL</Label>
                <Input
                  id="sse-url"
                  placeholder="https://example.com/sse-endpoint"
                  value={sseUrl}
                  onChange={(e) => { setSseUrl(e.target.value); }}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  The SSE endpoint URL
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sse-scope">Scope</Label>
                <SelectComponent
                  value={sseScope}
                  onValueChange={(value: string) => { setSseScope(value); }}
                  options={[
                    { value: "local", label: "Local (this project only)" },
                    { value: "project", label: "Project (shared via .mcp.json)" },
                    { value: "user", label: "User (all projects)" },
                  ]}
                />
              </div>

              {renderEnvVars("sse", sseEnvVars)}
            </div>

            <div className="pt-2">
              <Button
                onClick={fireAndLog('mcpadd-server:click', handleAddSseServer)}
                disabled={saving}
                className="w-full gap-2 bg-primary hover:bg-primary/90"
              >
                {saving ? (
                  <>
                    <Spinner />
                    Adding Server...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Add SSE Server
                  </>
                )}
              </Button>
            </div>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="p-4 bg-muted/30">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Info className="h-4 w-4 text-primary" />
            <span>Example Commands</span>
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="font-mono bg-background p-2 rounded">
              <p>• Postgres: /path/to/postgres-mcp-server --connection-string "postgresql://..."</p>
              <p>• Weather API: /usr/local/bin/weather-cli --api-key ABC123</p>
              <p>• SSE Server: https://api.example.com/mcp/stream</p>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}; 