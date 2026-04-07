import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronDown,
  ChevronUp,
  Shield,
  ShieldCheck,
  ShieldX,
  Terminal,
  FileEdit,
  FolderOpen,
  Search,
  Eye,
} from "lucide-react";
import { api } from "@/lib/api";

const TOOL_ICONS: Record<string, React.ElementType> = {
  Bash: Terminal,
  Edit: FileEdit,
  MultiEdit: FileEdit,
  Write: FileEdit,
  Read: Eye,
  Glob: FolderOpen,
  Grep: Search,
};

interface PermissionPromptProps {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, any>;
  autoAllowedTools: Set<string>;
  onAutoAllow: (toolName: string) => void;
  onResponded: () => void;
}

export function PermissionPrompt({
  sessionId,
  toolName,
  toolInput,
  autoAllowedTools,
  onAutoAllow,
  onResponded,
}: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(true);
  const [responding, setResponding] = useState(false);
  const [textInput, setTextInput] = useState("");

  const Icon = TOOL_ICONS[toolName] || Shield;

  const sendResponse = async (response: string) => {
    setResponding(true);
    try {
      await api.sendSessionInput(sessionId, response);
      onResponded();
    } catch (err) {
      console.error("Failed to send permission response:", err);
    } finally {
      setResponding(false);
    }
  };

  const handleAllow = () => sendResponse("y");
  const handleDeny = () => sendResponse("n");
  const handleAlwaysAllow = () => {
    onAutoAllow(toolName);
    sendResponse("y");
  };
  const handleTextSubmit = () => {
    if (textInput.trim()) {
      sendResponse(textInput.trim());
      setTextInput("");
    }
  };

  const formatArgs = () => {
    if (toolInput.command) return toolInput.command;
    if (toolInput.file_path) return toolInput.file_path;
    if (toolInput.pattern) return toolInput.pattern;
    return JSON.stringify(toolInput, null, 2);
  };

  return (
    <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-lg p-4 my-2">
      <div className="flex items-center gap-2 mb-2">
        <Shield className="w-4 h-4 text-yellow-500" />
        <span className="text-sm font-medium text-yellow-500">Permission Required</span>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-5 h-5 text-foreground/70" />
        <span className="font-mono text-sm font-semibold">{toolName}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-auto text-foreground/50 hover:text-foreground/80"
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {expanded && (
        <pre className="text-xs font-mono bg-black/20 rounded p-3 mb-3 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
          {formatArgs()}
        </pre>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={handleAllow}
          disabled={responding}
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          <ShieldCheck className="w-3 h-3 mr-1" />
          Allow
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={handleDeny}
          disabled={responding}
        >
          <ShieldX className="w-3 h-3 mr-1" />
          Deny
        </Button>
        {!autoAllowedTools.has(toolName) && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleAlwaysAllow}
            disabled={responding}
            className="text-xs"
          >
            Always Allow ({toolName})
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2">
        <Input
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleTextSubmit()}
          placeholder="Or type a response..."
          className="text-sm h-8"
          disabled={responding}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleTextSubmit}
          disabled={responding || !textInput.trim()}
          className="h-8"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
