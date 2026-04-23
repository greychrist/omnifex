import React from "react";
import {
  User,
  Bot,
  Terminal,
  Settings,
  Info,
  CheckCircle2,
  AlertCircle,
  CircleStop,
  Pencil,
  CheckSquare,
  ListChecks,
  ListTree,
  FolderTree,
  FileText,
  FilePlus,
  Search,
  Globe,
  Download,
  Plug,
} from "lucide-react";
import type { IconName } from "@/lib/messageRenderingConfig";

const LUCIDE_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  User,
  Bot,
  Terminal,
  Settings,
  Info,
  CheckCircle2,
  AlertCircle,
  CircleStop,
  Pencil,
  CheckSquare,
  ListChecks,
  ListTree,
  FolderTree,
  FileText,
  FilePlus,
  Search,
  Globe,
  Download,
  Plug,
};

export const IconRenderer: React.FC<{ name: IconName; className?: string }> = ({
  name,
  className = "h-4 w-4",
}) => {
  if (name === "none") return null;
  if (name === "ℹ" || name === "✗" || name === "⚠") {
    return <span className={className}>{name}</span>;
  }
  const Lucide = LUCIDE_MAP[name];
  if (!Lucide) return null;
  return <Lucide className={className} />;
};
