import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FolderOpen, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Project } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/AccountBadge";

type SortKey = 'name' | 'path' | 'account' | 'sessions' | 'lastActivity';
type SortDir = 'asc' | 'desc';

/**
 * Format a Unix-seconds timestamp as a compact relative-time string
 * ("2h ago", "3d ago", "5mo ago"). Falls back to a date when older than
 * a year. The Projects list cares about recency at-a-glance, not exact
 * dates — relative reads more naturally.
 */
function formatRelativeTime(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)}d ago`;
  if (diff < 86_400 * 365) return `${Math.floor(diff / (86_400 * 30))}mo ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

interface ProjectListProps {
  /**
   * Array of projects to display
   */
  projects: Project[];
  /**
   * Callback when a project is clicked
   */
  onProjectClick: (project: Project) => void;
  /**
   * Callback when open project is clicked
   */
  onOpenProject?: () => void | Promise<void>;
  /**
   * Whether the list is currently loading
   */
  loading?: boolean;
  /**
   * Optional className for styling
   */
  className?: string;
}

/**
 * Extracts the project name from the full path
 */
const getProjectName = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
};

/**
 * Formats path to be more readable - shows full path relative to home
 * Truncates long paths with ellipsis in the middle
 */
const getDisplayPath = (path: string, maxLength: number = 30): string => {
  // Try to make path home-relative
  let displayPath = path;
  const homeIndicators = ['/Users/', '/home/'];
  for (const indicator of homeIndicators) {
    if (path.includes(indicator)) {
      const parts = path.split('/');
      const userIndex = parts.findIndex((_part, i) => 
        i > 0 && parts[i - 1] === indicator.split('/')[1]
      );
      if (userIndex > 0) {
        const relativePath = parts.slice(userIndex + 1).join('/');
        displayPath = `~/${relativePath}`;
        break;
      }
    }
  }
  
  // Truncate if too long
  if (displayPath.length > maxLength) {
    const start = displayPath.substring(0, Math.floor(maxLength / 2) - 2);
    const end = displayPath.substring(displayPath.length - Math.floor(maxLength / 2) + 2);
    return `${start}...${end}`;
  }
  
  return displayPath;
};

/**
 * ProjectList component - Displays recent projects in a Cursor-like interface
 * 
 * @example
 * <ProjectList
 *   projects={projects}
 *   onProjectClick={(project) => console.log('Selected:', project)}
 *   onOpenProject={() => console.log('Open project')}
 * />
 */
export const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  onProjectClick,
  onOpenProject,
  className,
}) => {
  const [sortKey, setSortKey] = useState<SortKey>('lastActivity');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [accountFilter, setAccountFilter] = useState<string>('all');

  // Distinct account names present in the project list — sorted alpha for
  // a stable dropdown order. `'(unassigned)'` covers projects with no
  // resolved account so they're filterable too.
  const accountOptions = useMemo(() => {
    const names = new Set<string>();
    for (const p of projects) {
      names.add(p.account_name ?? '(unassigned)');
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [projects]);

  const visibleProjects = useMemo(() => {
    const filtered = accountFilter === 'all'
      ? projects
      : projects.filter((p) => (p.account_name ?? '(unassigned)') === accountFilter);

    const dir = sortDir === 'asc' ? 1 : -1;
    const cmp = (a: Project, b: Project): number => {
      switch (sortKey) {
        case 'name':
          return getProjectName(a.path).localeCompare(getProjectName(b.path)) * dir;
        case 'path':
          return a.path.localeCompare(b.path) * dir;
        case 'account':
          return (a.account_name ?? '').localeCompare(b.account_name ?? '') * dir;
        case 'sessions':
          return (a.sessions.length - b.sessions.length) * dir;
        case 'lastActivity': {
          // last_activity_at = newest file mtime in the project folder.
          // Undefined when the folder no longer exists on disk — no fallback
          // (don't lie about activity using session JSONL mtimes).
          const av = a.last_activity_at ?? 0;
          const bv = b.last_activity_at ?? 0;
          return (av - bv) * dir;
        }
      }
    };
    return [...filtered].sort(cmp);
  }, [projects, accountFilter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // For numeric/date columns the useful default is descending (newest /
      // most-active first); for string columns ascending reads more naturally.
      setSortDir(key === 'sessions' || key === 'lastActivity' ? 'desc' : 'asc');
    }
  };

  const SortIcon: React.FC<{ k: SortKey }> = ({ k }) => {
    if (sortKey !== k) {
      return <ArrowUpDown className="inline h-3 w-3 ml-1 opacity-30" />;
    }
    return sortDir === 'asc'
      ? <ArrowUp className="inline h-3 w-3 ml-1 opacity-80" />
      : <ArrowDown className="inline h-3 w-3 ml-1 opacity-80" />;
  };

  return (
    <div className={cn("h-full overflow-hidden", className)}>
      <div className="max-w-6xl mx-auto flex flex-col h-full">
        {/* Header */}
        <div className="p-6 shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Projects</h1>
              <p className="mt-1 text-body-small text-muted-foreground">
                Select a project to start working with Claude Code
              </p>
            </div>
            <motion.div
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.15 }}
            >
              <Button
                onClick={onOpenProject}
                size="default"
                className="flex items-center gap-2"
              >
                <FolderOpen className="h-4 w-4" />
                Open Project
              </Button>
            </motion.div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 px-6 pb-6 flex flex-col">
          {/* Recent projects section */}
          {projects.length > 0 ? (
            <Card className="p-6 flex-1 min-h-0 flex flex-col">
              <div className="flex items-center justify-between mb-4 gap-3 shrink-0">
                <h2 className="text-heading-4">
                  Recent Projects
                  <span className="ml-2 text-caption text-muted-foreground font-normal">
                    ({visibleProjects.length}{accountFilter !== 'all' ? ` of ${projects.length}` : ''})
                  </span>
                </h2>
                {accountOptions.length > 1 && (
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Account
                    </label>
                    <Select value={accountFilter} onValueChange={setAccountFilter}>
                      <SelectTrigger className="h-7 text-xs w-auto">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        {accountOptions.map((name) => (
                          <SelectItem key={name} value={name}>{name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
          
          <div className="-mx-2 flex-1 min-h-0 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border/50">
                  <th
                    className="px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort('name')}
                  >
                    Name<SortIcon k="name" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort('path')}
                  >
                    Path<SortIcon k="path" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort('account')}
                  >
                    Account<SortIcon k="account" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-right cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort('sessions')}
                  >
                    Sessions<SortIcon k="sessions" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-right cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort('lastActivity')}
                    title="Newest file modification time anywhere within the project folder. Excludes node_modules, .git, build artifacts, etc."
                  >
                    Last activity<SortIcon k="lastActivity" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleProjects.map((project, index) => {
                  // No fallback: if last_activity_at is undefined the folder
                  // no longer exists on disk, so we render an em-dash rather
                  // than a misleading session-mtime timestamp.
                  const lastActivity = project.last_activity_at ?? 0;
                  return (
                    <motion.tr
                      key={project.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15, delay: index * 0.02 }}
                      onClick={() => onProjectClick(project)}
                      className="border-b border-border/30 hover:bg-accent/40 transition-colors cursor-pointer"
                    >
                      <td className="px-3 py-2 font-medium">
                        {getProjectName(project.path)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground font-mono text-xs truncate max-w-[420px]" title={project.path}>
                        {getDisplayPath(project.path, 60)}
                      </td>
                      <td className="px-3 py-2">
                        {project.account_name && (
                          <AccountBadge name={project.account_name} />
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                        {project.sessions.length}
                      </td>
                      <td
                        className="px-3 py-2 text-right text-muted-foreground text-xs tabular-nums"
                        title={
                          lastActivity
                            ? new Date(lastActivity * 1000).toLocaleString()
                            : ''
                        }
                      >
                        {lastActivity ? formatRelativeTime(lastActivity) : '—'}
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>
            </Card>
          ) : (
            <Card className="p-12">
              <div className="flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
                  <FolderOpen className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-heading-3 mb-2">No recent projects</h3>
                <p className="text-body-small text-muted-foreground mb-6">
                  Open a project to get started with Claude Code
                </p>
                <motion.div
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                >
                  <Button
                    onClick={onOpenProject}
                    size="default"
                    className="flex items-center gap-2"
                  >
                    <FolderOpen className="h-4 w-4" />
                    Open Your First Project
                  </Button>
                </motion.div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}; 
