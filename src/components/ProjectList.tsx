import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FolderOpen, Plus, ArrowUp, ArrowDown, ArrowUpDown, Zap, List, Pin, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import type { Project } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/AccountBadge";
import { AccountPicker } from "@/components/AccountPicker";
import { fireAndLog } from "@/lib/fireAndLog";

type SortKey = 'name' | 'account' | 'lastActivity';
type SortDir = 'asc' | 'desc';

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
  projects: Project[];
  onProjectClick: (project: Project) => void;
  onOpenProject?: () => void | Promise<void>;
  onNewProject?: () => void | Promise<void>;
  onQuickLaunch?: (project: Project) => void | Promise<void>;
  onTogglePin?: (project: Project, pinned: boolean) => void | Promise<void>;
  onOpenSettings?: (project: Project) => void | Promise<void>;
  loading?: boolean;
  className?: string;
}

const getProjectName = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
};

const getDisplayPath = (path: string): string => {
  const homeIndicators = ['/Users/', '/home/'];
  for (const indicator of homeIndicators) {
    if (path.includes(indicator)) {
      const parts = path.split('/');
      const userIndex = parts.findIndex((_part, i) =>
        i > 0 && parts[i - 1] === indicator.split('/')[1]
      );
      if (userIndex > 0) {
        return `~/${parts.slice(userIndex + 1).join('/')}`;
      }
    }
  }
  return path;
};

export const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  onProjectClick,
  onOpenProject,
  onNewProject,
  onQuickLaunch,
  onTogglePin,
  onOpenSettings,
  loading = false,
  className,
}) => {
  const [sortKey, setSortKey] = useState<SortKey>('lastActivity');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [accountFilter, setAccountFilter] = useState<string>('all');

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
    const bySortKey = (a: Project, b: Project): number => {
      switch (sortKey) {
        case 'name':
          return getProjectName(a.path).localeCompare(getProjectName(b.path)) * dir;
        case 'account':
          return (a.account_name ?? '').localeCompare(b.account_name ?? '') * dir;
        case 'lastActivity': {
          // Session mtime only: working-tree edits and `git pull` are not Claude activity.
          const av = a.most_recent_session ?? 0;
          const bv = b.most_recent_session ?? 0;
          return (av - bv) * dir;
        }
      }
    };

    // Pinned-first is deliberately NOT multiplied by `dir`, or ascending sorts sink pinned rows.
    const cmp = (a: Project, b: Project): number => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return bySortKey(a, b);
    };
    return [...filtered].sort(cmp);
  }, [projects, accountFilter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'lastActivity' ? 'desc' : 'asc');
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
    <TooltipProvider>
    <div className={cn("h-full overflow-hidden", className)}>
      <div className="max-w-6xl mx-auto flex flex-col h-full">
        <div className="p-6 shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Projects</h1>
              <p className="mt-1 text-body-small text-muted-foreground">
                Select a project to start working with Claude Code
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onNewProject && (
                <motion.div
                  whileTap={{ scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                >
                  <Button
                    onClick={fireAndLog('project-list:new-project', onNewProject)}
                    variant="outline"
                    size="default"
                    className="flex items-center gap-2"
                  >
                    <Plus className="h-4 w-4" />
                    New Project
                  </Button>
                </motion.div>
              )}
              <motion.div
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.15 }}
              >
                <Button
                  onClick={fireAndLog('project-list:click', onOpenProject)}
                  size="default"
                  className="flex items-center gap-2"
                >
                  <FolderOpen className="h-4 w-4" />
                  Open Project
                </Button>
              </motion.div>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 px-6 pb-6 flex flex-col">
          {loading && projects.length === 0 ? (
            <Card className="p-6 flex-1 min-h-0 flex flex-col" data-testid="project-list-skeleton" aria-busy="true">
              <div className="h-6 w-48 mb-4 rounded bg-muted animate-pulse" />
              <div className="flex flex-col gap-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="h-4 w-6 rounded bg-muted animate-pulse" />
                    <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                    <div className="h-8 flex-1 rounded bg-muted animate-pulse" />
                    <div className="h-4 w-20 rounded bg-muted animate-pulse" />
                    <div className="h-4 w-24 rounded bg-muted animate-pulse" />
                  </div>
                ))}
              </div>
            </Card>
          ) : projects.length > 0 ? (
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
                    <AccountPicker
                      accounts={accountOptions}
                      value={accountFilter}
                      onChange={setAccountFilter}
                      allowAll
                    />
                  </div>
                )}
              </div>
          
          <div className="-mx-2 flex-1 min-h-0 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border/50">
                  <th className="w-12 px-2 py-2 font-medium">Pin</th>
                  <th className="w-[104px] px-3 py-2 font-medium">Actions</th>
                  <th
                    className="w-full px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort('name'); }}
                  >
                    Name<SortIcon k="name" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort('account'); }}
                  >
                    Account<SortIcon k="account" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-right cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort('lastActivity'); }}
                    title="When Claude last had a session for this project."
                  >
                    Last activity<SortIcon k="lastActivity" />
                  </th>
                  <th className="w-20 px-3 py-2 font-medium">Settings</th>
                </tr>
              </thead>
              <tbody>
                {visibleProjects.map((project, index) => {
                  const lastActivity = project.most_recent_session ?? 0;
                  const isPinBoundary =
                    !!project.pinned && !!visibleProjects[index + 1] && !visibleProjects[index + 1].pinned;
                  return (
                    <motion.tr
                      data-pin-boundary={isPinBoundary ? 'true' : undefined}
                      key={project.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15, delay: index * 0.02 }}
                      className={cn(
                        "transition-colors hover:bg-accent/40",
                        "border-b border-border/30",
                        // 5px double = 1px/3px/1px lines. Not a box-shadow: rows in a collapsed table never paint one.
                        // `!` because the unlayered `* { border-color }` in styles.css overrides border-color utilities.
                        isPinBoundary &&
                          "border-b-[5px] [border-bottom-style:double] [border-bottom-color:color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]!",
                      )}
                    >
                      <td className="px-2 py-2 align-top">
                        {onTogglePin && (
                          <TooltipSimple content={project.pinned ? "Unpin this project" : "Pin this project to the top"}>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                void onTogglePin(project, !project.pinned);
                              }}
                              className={cn(
                                "h-8 w-8",
                                project.pinned
                                  ? "text-foreground"
                                  : "text-muted-foreground/60",
                              )}
                              aria-label={project.pinned ? "Unpin this project" : "Pin this project"}
                            >
                              <Pin className={cn("h-3.5 w-3.5", project.pinned && "fill-current")} />
                            </Button>
                          </TooltipSimple>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="flex items-center justify-end gap-1.5">
                          <TooltipSimple content="View this project's sessions">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                onProjectClick(project);
                              }}
                              className="h-8 min-w-[3.25rem] gap-1 px-2 tabular-nums"
                              aria-label={`Sessions (${project.sessions.length})`}
                            >
                              <List className="h-3.5 w-3.5" />
                              {project.sessions.length}
                            </Button>
                          </TooltipSimple>
                          {onQuickLaunch && (
                            <TooltipSimple content="Quick launch a new session (skips the sessions page)">
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onQuickLaunch(project);
                                }}
                                className="h-8 w-8"
                                aria-label="Launch"
                              >
                                <Zap className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipSimple>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-medium">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <button
                              type="button"
                              data-project-name
                              onClick={() => { onProjectClick(project); }}
                              className="block max-w-full truncate text-left text-foreground hover:underline focus-visible:underline focus:outline-none"
                              title="View this project's sessions"
                            >
                              {getProjectName(project.path)}
                            </button>
                            {/* break-all, not break-words: paths have no spaces to break at. */}
                            <div
                              data-project-path
                              className="break-all font-mono text-[11px] font-normal leading-tight text-muted-foreground/70"
                              title={project.path}
                            >
                              {getDisplayPath(project.path)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {project.account_name && (
                          <AccountBadge name={project.account_name} />
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-right text-muted-foreground text-xs tabular-nums whitespace-nowrap"
                        title={
                          lastActivity
                            ? new Date(lastActivity * 1000).toLocaleString()
                            : ''
                        }
                      >
                        {lastActivity ? formatRelativeTime(lastActivity) : '—'}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {onOpenSettings && (
                          <TooltipSimple content="Project settings — CLAUDE.md and hooks">
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                void onOpenSettings(project);
                              }}
                              className="h-8 w-8 text-muted-foreground"
                              aria-label="Project settings"
                            >
                              <Settings className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipSimple>
                        )}
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
                    onClick={fireAndLog('project-list:click', onOpenProject)}
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
    </TooltipProvider>
  );
};
