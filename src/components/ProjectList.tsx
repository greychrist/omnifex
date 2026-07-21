import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FolderOpen, ArrowUp, ArrowDown, ArrowUpDown, Zap, List, Pin, Infinity as InfinityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import type { Project } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/AccountBadge";
import { fireAndLog } from "@/lib/fireAndLog";

type SortKey = 'name' | 'path' | 'account' | 'sessions' | 'lastActivity';
type SortDir = 'asc' | 'desc';

/**
 * "All accounts" badge for the project filter. Matches AccountBadge's
 * `size="sm"` shape (`text-xs`, 15px icon, `px-2 py-0.5`, rounded border)
 * but uses theme-neutral muted tokens since "All" isn't a real account
 * and shouldn't pull from any account's color stack. Used in both the
 * closed dropdown trigger and the open dropdown items.
 */
const AllAccountsBadge: React.FC = () => (
  <span className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground whitespace-nowrap">
    <InfinityIcon className="h-[15px] w-[15px]" strokeWidth={2.2} />
    All
  </span>
);

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
   * Callback to open the project's sessions page. Fired by clicking the
   * project name (rendered as a link) or the Sessions icon — never by
   * clicking elsewhere in the row.
   */
  onProjectClick: (project: Project) => void;
  /**
   * Callback when open project is clicked
   */
  onOpenProject?: () => void | Promise<void>;
  /**
   * Optional callback fired by the Quick Launch icon. Starts a brand-new
   * session for the project immediately, bypassing the sessions page. The
   * parent owns the actual launch. When omitted, the Quick Launch icon is
   * hidden so this component degrades gracefully in callers (e.g. the
   * legacy non-tab view) that can't start a session inline.
   */
  onQuickLaunch?: (project: Project) => void | Promise<void>;
  /**
   * Optional callback fired when the user toggles a project's pin. Receives
   * the project and the DESIRED state. The parent owns the API call and the
   * refetch, so when omitted the pin icon is hidden and the list degrades
   * gracefully.
   */
  onTogglePin?: (project: Project, pinned: boolean) => void | Promise<void>;
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
const getDisplayPath = (path: string, maxLength = 30): string => {
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
  onQuickLaunch,
  onTogglePin,
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
    const bySortKey = (a: Project, b: Project): number => {
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
          // most_recent_session = newest Claude session JSONL mtime.
          // We deliberately do NOT walk the project's working tree — file
          // edits, formatter runs, and `git pull` are not "Claude activity."
          // Undefined → 0 (project has no Claude sessions yet).
          const av = a.most_recent_session ?? 0;
          const bv = b.most_recent_session ?? 0;
          return (av - bv) * dir;
        }
      }
    };

    // Pinned projects form a group that always leads, whatever the sort. The
    // active sort then orders rows *within* each group.
    //
    // Deliberately NOT multiplied by `dir`: every comparator above flips with
    // the sort direction, but this one must not. If it did, sorting ascending
    // would sink pinned projects to the bottom — the precise opposite of what
    // pinning is for. Covered by a test per sort key, per direction.
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
    <TooltipProvider>
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
                      {/* Trigger renders the badge directly when a real
                          account is selected — both the closed dropdown
                          and the dropdown items use AccountBadge size="sm"
                          so the badge inherits the surrounding text-xs
                          scale. "All" stays plain text since it's not an
                          account. The legacy "(unassigned)" bucket
                          (projects whose account didn't resolve) gets a
                          muted "No account" string for the same reason.
                          The trigger gets `[&>svg]:size-3` so the chevron
                          stays small even though the badge itself is
                          taller than bare text. */}
                      <SelectTrigger className="h-7 text-xs w-auto gap-1.5 pl-1 [&>svg]:size-3">
                        {/* Wrapper div keeps the badge out of
                            SelectTrigger's `[&>span]:line-clamp-1`
                            scope. Without it, line-clamp forces
                            `display: -webkit-box` on the badge span and
                            stacks the icon above the label. As a flex
                            child of the trigger (justify-between), the
                            div hugs its content on the left while the
                            chevron stays right. */}
                        <div className="inline-flex items-center">
                          {accountFilter === 'all' ? (
                            <AllAccountsBadge />
                          ) : accountFilter === '(unassigned)' ? (
                            <span className="text-muted-foreground">No account</span>
                          ) : (
                            <AccountBadge name={accountFilter} size="sm" />
                          )}
                        </div>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">
                          <AllAccountsBadge />
                        </SelectItem>
                        {accountOptions.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name === '(unassigned)' ? (
                              <span className="text-muted-foreground">No account</span>
                            ) : (
                              <AccountBadge name={name} size="sm" />
                            )}
                          </SelectItem>
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
                    onClick={() => { toggleSort('name'); }}
                  >
                    Name<SortIcon k="name" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort('path'); }}
                  >
                    Path<SortIcon k="path" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort('account'); }}
                  >
                    Account<SortIcon k="account" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-right cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort('sessions'); }}
                  >
                    Sessions<SortIcon k="sessions" />
                  </th>
                  <th
                    className="px-3 py-2 font-medium text-right cursor-pointer hover:text-foreground select-none"
                    onClick={() => { toggleSort('lastActivity'); }}
                    title="When Claude last had a session for this project."
                  >
                    Last activity<SortIcon k="lastActivity" />
                  </th>
                  {/* Actions column — header is intentionally empty; the
                      icons in each row carry their own tooltips. Width is
                      fixed so the column doesn't grow with row count. */}
                  <th className="px-3 py-2 w-[120px]" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visibleProjects.map((project, index) => {
                  // most_recent_session is undefined when the project has
                  // no Claude session JSONLs yet — render an em-dash so
                  // the column is visibly empty rather than showing an
                  // epoch-zero "55y ago".
                  const lastActivity = project.most_recent_session ?? 0;
                  // Close the pinned group with a heavier rule. Only the LAST
                  // pinned row carries it, and only when unpinned rows follow
                  // — all-pinned (or none-pinned) would otherwise render a
                  // stray line under the table with nothing to separate.
                  const isPinBoundary =
                    !!project.pinned && !!visibleProjects[index + 1] && !visibleProjects[index + 1].pinned;
                  return (
                    <motion.tr
                      data-pin-boundary={isPinBoundary ? 'true' : undefined}
                      key={project.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15, delay: index * 0.02 }}
                      // Subtle row hover for visual scan-tracking. The
                      // row itself is no longer interactive (only the
                      // name and the action icons are clickable), so
                      // we deliberately omit `cursor-pointer` here —
                      // the hover tint is presentational, not an
                      // affordance.
                      className={cn(
                        "transition-colors hover:bg-accent/40",
                        // Ordinary row separator.
                        "border-b border-border/30",
                        // The pinned group closes with a double rule, drawn as
                        // a 5px `border-bottom-style: double`. Chromium splits
                        // the width line/gap/line as floor(w/3) for each line
                        // and the remainder for the gap, so 5px gives 1px/3px/
                        // 1px: hairlines matching the other row separators,
                        // with an open gap between them. (3px would be 1/1/1 —
                        // the lines nearly touch and read as one thick rule;
                        // 7px would be 2/3/2, thickening the lines rather than
                        // opening the gap.)
                        //
                        // Not a box-shadow: Tailwind preflight leaves tables
                        // at `border-collapse: collapse`, and Chromium doesn't
                        // paint box-shadows on rows in a collapsed table — the
                        // rule would silently never appear. Borders do render
                        // (the row's own border-b proves it), and the collapse
                        // algorithm resolves on width, so 3px beats the next
                        // row's 1px and survives.
                        // The colour needs `!` and `color-mix`, for two
                        // reasons worth knowing: styles.css sets
                        // `* { border-color: var(--color-border) }` OUTSIDE
                        // any @layer, and unlayered rules beat layered ones
                        // regardless of specificity — so every Tailwind
                        // border-colour utility is overridden app-wide.
                        // And Tailwind bakes `border-*` colours to a hex at
                        // build time, which wouldn't follow the theme;
                        // `var()` inside color-mix resolves at runtime.
                        isPinBoundary &&
                          "border-b-[5px] [border-bottom-style:double] [border-bottom-color:color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]!",
                      )}
                    >
                      <td className="px-3 py-2 font-medium">
                        {/* Name renders as a link-styled <button> that opens
                            the project's sessions page. The launch/sessions
                            affordances live in the actions cell, so the name
                            carries no trailing glyph. The rest of the row has
                            no click target. */}
                        <button
                          type="button"
                          onClick={() => { onProjectClick(project); }}
                          className="inline-flex items-center gap-1 text-left text-foreground hover:underline focus-visible:underline focus:outline-none"
                          title="View this project's sessions"
                        >
                          {getProjectName(project.path)}
                        </button>
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
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {onTogglePin && (
                            <TooltipSimple content={project.pinned ? "Unpin this project" : "Pin this project to the top"}>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onTogglePin(project, !project.pinned);
                                }}
                                className={cn(
                                  "p-1 rounded-md transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                                  project.pinned
                                    ? "text-foreground hover:text-muted-foreground hover:bg-accent/60"
                                    : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                                )}
                                aria-label={project.pinned ? "Unpin this project" : "Pin this project"}
                              >
                                <Pin className={cn("h-4 w-4", project.pinned && "fill-current")} />
                              </button>
                            </TooltipSimple>
                          )}
                          {onQuickLaunch && (
                            <TooltipSimple content="Quick launch a new session (skips the sessions page)">
                              <button
                                type="button"
                                onClick={(e) => {
                                  // Belt-and-suspenders: stop the click from
                                  // bubbling to any future row-level handler.
                                  e.stopPropagation();
                                  void onQuickLaunch(project);
                                }}
                                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                aria-label="Quick launch a new session"
                              >
                                <Zap className="h-4 w-4" />
                              </button>
                            </TooltipSimple>
                          )}
                          <TooltipSimple content="View this project's sessions">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onProjectClick(project);
                              }}
                              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              aria-label="View project sessions"
                            >
                              <List className="h-4 w-4" />
                            </button>
                          </TooltipSimple>
                        </div>
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
