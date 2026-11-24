import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Toast, ToastContainer } from "@/components/ui/toast";
import { api, type MCPServer } from "@/lib/api";
import { MCPServerList } from "./MCPServerList";
import { MCPAddServer } from "./MCPAddServer";
import { MCPImportExport } from "./MCPImportExport";
import { fireAndLog, logAndForget } from "@/lib/fireAndLog";

interface MCPManagerProps {
  onBack: () => void;
  className?: string;
  configDir?: string;
}

export const MCPManager: React.FC<MCPManagerProps> = ({
  className: _className,
  configDir,
}) => {
  const [activeTab, setActiveTab] = useState("servers");
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  

  const loadServers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      console.log("MCPManager: Loading servers...");
      const serverList = await api.mcpList(configDir);
      console.log("MCPManager: Received server list:", serverList);
      console.log("MCPManager: Server count:", serverList.length);
      setServers(serverList);
    } catch (err) {
      console.error("MCPManager: Failed to load MCP servers:", err);
      setError("Failed to load MCP servers. Make sure Claude Code is installed.");
    } finally {
      setLoading(false);
    }
  }, [configDir]);

  useEffect(() => {
    logAndForget('mcpmanager:load-servers', loadServers());
  }, [loadServers]);

  const handleServerAdded = () => {
    logAndForget('mcpmanager:load-servers', loadServers());
    setToast({ message: "MCP server added successfully!", type: "success" });
    setActiveTab("servers");
  };

  const handleServerRemoved = (name: string) => {
    setServers(prev => prev.filter(s => s.name !== name));
    setToast({ message: `Server "${name}" removed successfully!`, type: "success" });
  };

  const handleImportCompleted = (imported: number, failed: number) => {
    logAndForget('mcpmanager:load-servers', loadServers());
    if (failed === 0) {
      setToast({ 
        message: `Successfully imported ${imported} server${imported > 1 ? 's' : ''}!`, 
        type: "success" 
      });
    } else {
      setToast({ 
        message: `Imported ${imported} server${imported > 1 ? 's' : ''}, ${failed} failed`, 
        type: "error" 
      });
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto flex flex-col h-full">
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-heading-1">MCP Servers</h1>
              <p className="mt-1 text-body-small text-muted-foreground">
                Manage Model Context Protocol servers
              </p>
            </div>
          </div>
        </div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mx-6 mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/50 flex items-center gap-2 text-body-small text-destructive"
            >
              <AlertCircle className="h-4 w-4" />
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner className="size-8 text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className="grid grid-cols-3 w-full max-w-md mb-6 h-auto p-1">
                <TabsTrigger value="servers" className="py-2.5 px-3">
                  Servers
                </TabsTrigger>
                <TabsTrigger value="add" className="py-2.5 px-3">
                  Add Server
                </TabsTrigger>
                <TabsTrigger value="import" className="py-2.5 px-3">
                  Import/Export
                </TabsTrigger>
              </TabsList>

              <TabsContent value="servers" className="space-y-6 mt-6">
                <Card>
                  <MCPServerList
                    servers={servers}
                    loading={false}
                    onServerRemoved={handleServerRemoved}
                    onRefresh={fireAndLog('mcpmanager:refresh', loadServers)}
                    configDir={configDir}
                  />
                </Card>
              </TabsContent>

              <TabsContent value="add" className="space-y-6 mt-6">
                <Card>
                  <MCPAddServer
                    onServerAdded={handleServerAdded}
                    onError={(message: string) => { setToast({ message, type: "error" }); }}
                    configDir={configDir}
                  />
                </Card>
              </TabsContent>

              <TabsContent value="import" className="space-y-6 mt-6">
                <Card className="overflow-hidden">
                  <MCPImportExport
                    onImportCompleted={handleImportCompleted}
                    onError={(message: string) => { setToast({ message, type: "error" }); }}
                    configDir={configDir}
                  />
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>

      <ToastContainer>
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => { setToast(null); }}
          />
        )}
      </ToastContainer>
    </div>
  );
}; 