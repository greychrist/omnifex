import * as React from 'react';
import { ChevronDown, ChevronRight, FolderGit2, RefreshCw, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { BranchColorsEditor } from '@/components/BranchColorsEditor';
import { api, type ProjectRepos } from '@/lib/api';
import { fireAndLog } from '@/lib/fireAndLog';

/**
 * The repos in a project and which of them its sessions watch, plus each
 * repo's branch colours. Opened from a session's git bar and from the
 * project screen; choices are saved per project and reach every open session
 * of it live.
 */

const DEPTHS = [1, 2, 3, 4, 5];

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Load a project's repos, reloading when any client changes them. */
function useProjectRepos(projectPath: string, enabled: boolean) {
  const [data, setData] = React.useState<ProjectRepos | null>(null);
  const [loading, setLoading] = React.useState(false);
  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getProjectRepos(projectPath));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);
  React.useEffect(() => {
    if (!enabled) return;
    void reload();
    return api.onProjectReposChanged((p) => { if (p === projectPath) void reload(); });
  }, [enabled, projectPath, reload]);
  return { data, loading, reload };
}

interface RowProps {
  name: string;
  path: string;
  watched: boolean;
  locked?: boolean;
  missing?: boolean;
  onWatch?: (watched: boolean) => void;
  onRemove?: () => void;
}

const RepoRow: React.FC<RowProps> = ({ name, path, watched, locked, missing, onWatch, onRemove }) => {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div className="rounded border border-border/50">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          aria-label={`Branch colours for ${name}`}
          aria-expanded={expanded}
          disabled={missing}
          onClick={() => { setExpanded((v) => !v); }}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:opacity-60"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs truncate">{name}</span>
          {locked && <span className="text-[10px] text-muted-foreground">project folder</span>}
          {missing && <span className="text-[10px] text-rose-400">missing</span>}
          <span className="ml-1 truncate text-[10px] text-muted-foreground/70">{path}</span>
        </button>
        {missing && onRemove ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
            className="h-7 w-7 p-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Switch
            aria-label={`Watch ${name}`}
            checked={watched}
            disabled={locked}
            onCheckedChange={(v) => { onWatch?.(v); }}
          />
        )}
      </div>
      {expanded && !missing && (
        <div className="border-t border-border/50 px-3 py-2">
          <BranchColorsEditor repoPath={path} />
        </div>
      )}
    </div>
  );
};

export interface ProjectReposDialogProps {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ProjectReposDialog: React.FC<ProjectReposDialogProps> = ({ projectPath, open, onOpenChange }) => {
  const { data, loading, reload } = useProjectRepos(projectPath, open);

  const setDepth = async (depth: number) => {
    await api.setProjectRepoScanDepth(projectPath, depth);
    await reload();
  };
  const setWatched = async (repoPath: string, watched: boolean) => {
    await api.setProjectRepoWatched(projectPath, repoPath, watched);
    await reload();
  };
  const remove = async (repoPath: string) => {
    await api.removeProjectRepo(projectPath, repoPath);
    await reload();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Repos in this project</DialogTitle>
          <DialogDescription>
            Turn on the repos this project&apos;s sessions should show. Branch colours belong to each repo.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Scan depth</span>
            <select
              aria-label="Scan depth"
              value={data?.scanDepth ?? 1}
              onChange={fireAndLog('project-repos:depth', (e: React.ChangeEvent<HTMLSelectElement>) => setDepth(Number(e.target.value)))}
              className="h-7 rounded border border-border bg-background px-1.5 text-xs"
            >
              {DEPTHS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={fireAndLog('project-repos:rescan', reload)}
            disabled={loading}
            className="h-7 gap-1 px-2 text-xs"
          >
            <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            Rescan
          </Button>
        </div>

        {data?.truncated && (
          <p className="text-xs text-amber-500">Showing the first 50 repos. Lower the scan depth to narrow it.</p>
        )}

        <div className="max-h-[60vh] space-y-1.5 overflow-y-auto">
          {data?.rootIsRepo && (
            <RepoRow name={basename(data.rootPath)} path={data.rootPath} watched locked />
          )}
          {data?.repos.map((repo) => (
            <RepoRow
              key={repo.path}
              name={repo.name}
              path={repo.path}
              watched={repo.watched}
              missing={repo.missing}
              onWatch={fireAndLog('project-repos:watch', (v: boolean) => setWatched(repo.path, v))}
              onRemove={fireAndLog('project-repos:remove', () => remove(repo.path))}
            />
          ))}
          {data && !data.rootIsRepo && data.repos.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No git repos found{data.scanDepth < 5 ? ' — try a deeper scan.' : '.'}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

/** The project screen's entry point: a summary and a button that opens the dialog. */
export const ProjectReposCard: React.FC<{ projectPath: string }> = ({ projectPath }) => {
  const [open, setOpen] = React.useState(false);
  const { data } = useProjectRepos(projectPath, true);
  const watched = (data?.rootIsRepo ? 1 : 0) + (data?.repos.filter((r) => r.watched && !r.missing).length ?? 0);
  const found = data?.repos.filter((r) => !r.watched).length ?? 0;
  return (
    <Card className="flex h-full flex-col gap-2 p-4">
      <h2 className="text-sm font-semibold">Repos &amp; branch colours</h2>
      <p className="text-xs text-muted-foreground">
        {data
          ? `${watched} watched${found > 0 ? ` · ${found} more found` : ''}`
          : 'Scanning…'}
      </p>
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={() => { setOpen(true); }} className="h-7 self-start px-2 text-xs">
        Manage…
      </Button>
      <ProjectReposDialog projectPath={projectPath} open={open} onOpenChange={setOpen} />
    </Card>
  );
};
