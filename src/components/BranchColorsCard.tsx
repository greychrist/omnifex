import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ColorSwatchGrid, SWATCHES } from '@/components/ui/ColorSwatchGrid';
import { GitBranchBadge } from '@/components/claude-code-session/GitBranchBadge';
import { resolveBranchColors } from '@/lib/branchColors';
import { Pencil, Plus, Trash2, Check, X } from 'lucide-react';
import { api, type BranchColor } from '@/lib/api';

interface BranchColorsCardProps {
  projectPath: string;
  /** Used to populate the branch dropdown in add/edit mode. */
  availableBranches: string[];
  /** Current main-folder branch, used for the chip preview only. */
  mainFolderBranch: string | null;
}

export const BranchColorsCard: React.FC<BranchColorsCardProps> = ({
  projectPath,
  availableBranches,
  mainFolderBranch,
}) => {
  const [rows, setRows] = React.useState<BranchColor[]>([]);
  const [editing, setEditing] = React.useState<{ id: number | null; branch: string; color: string } | null>(null);

  const refresh = React.useCallback(async () => {
    setRows(await api.listBranchColors(projectPath));
  }, [projectPath]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const startAdd = () => {
    const taken = new Set(rows.map((r) => r.branch_name));
    const firstFree = availableBranches.find((b) => !taken.has(b)) ?? '';
    setEditing({ id: null, branch: firstFree, color: SWATCHES[5] /* blue */ });
  };

  const startEdit = (row: BranchColor) => {
    setEditing({ id: row.id, branch: row.branch_name, color: row.color });
  };

  const cancel = () => setEditing(null);

  const save = async () => {
    if (!editing || !editing.branch) return;
    await api.upsertBranchColor({
      projectPath,
      branchName: editing.branch,
      color: editing.color,
    });
    setEditing(null);
    await refresh();
  };

  const remove = async (id: number) => {
    await api.deleteBranchColor(id);
    await refresh();
  };

  // Preview chips use the resolver in isolation per row so each row reads how
  // the chip will actually render in the session header.
  const branchesForPreview = rows.map((r) => r.branch_name);
  const preview = resolveBranchColors({
    pins: Object.fromEntries(rows.map((r) => [r.branch_name, r.color])),
    mainFolderBranch,
    branches: branchesForPreview,
  });

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Branch Colors</h2>
        {!editing && (
          <Button size="sm" variant="outline" onClick={startAdd} className="h-7 px-2 gap-1 text-xs">
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>

      {rows.length === 0 && !editing && (
        <p className="text-xs text-muted-foreground">No pinned colors yet.</p>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const isEditingRow = editing?.id === row.id;
          if (isEditingRow) {
            return (
              <EditorRow
                key={row.id}
                editing={editing!}
                setEditing={setEditing}
                availableBranches={availableBranches}
                takenBranches={new Set(rows.filter((r) => r.id !== row.id).map((r) => r.branch_name))}
                onSave={save}
                onCancel={cancel}
              />
            );
          }
          return (
            <div key={row.id} className="flex items-center gap-2">
              <GitBranchBadge
                name={row.branch_name}
                changed={0}
                untracked={0}
                color={preview.colors[row.branch_name] ?? row.color}
                isTrunk={preview.trunkBlack.has(row.branch_name)}
              />
              <span className="text-xs text-muted-foreground flex-1 truncate">{row.branch_name}</span>
              <Button size="sm" variant="ghost" onClick={() => startEdit(row)} className="h-7 w-7 p-0">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove(row.id)} className="h-7 w-7 p-0">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}

        {editing && editing.id === null && (
          <EditorRow
            editing={editing}
            setEditing={setEditing}
            availableBranches={availableBranches}
            takenBranches={new Set(rows.map((r) => r.branch_name))}
            onSave={save}
            onCancel={cancel}
          />
        )}
      </div>
    </Card>
  );
};

interface EditorRowProps {
  editing: { id: number | null; branch: string; color: string };
  setEditing: (e: { id: number | null; branch: string; color: string }) => void;
  availableBranches: string[];
  takenBranches: Set<string>;
  onSave: () => void;
  onCancel: () => void;
}

const EditorRow: React.FC<EditorRowProps> = ({ editing, setEditing, availableBranches, takenBranches, onSave, onCancel }) => {
  const branches = availableBranches.length > 0
    ? availableBranches.filter((b) => !takenBranches.has(b) || b === editing.branch)
    : [];

  return (
    <div className="rounded border border-border/50 p-2 space-y-2">
      {branches.length > 0 ? (
        <Select value={editing.branch} onValueChange={(v) => setEditing({ ...editing, branch: v })}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Choose a branch" />
          </SelectTrigger>
          <SelectContent>
            {branches.map((b) => (
              <SelectItem key={b} value={b} className="text-xs">{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-xs text-muted-foreground">No branches detected — open a git repo first.</p>
      )}
      <ColorSwatchGrid value={editing.color} onChange={(color) => setEditing({ ...editing, color })} />
      <div className="flex gap-1 justify-end">
        <Button size="sm" variant="outline" onClick={onCancel} className="h-7 px-2 gap-1 text-xs">
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={!editing.branch} className="h-7 px-2 gap-1 text-xs">
          <Check className="h-3.5 w-3.5" /> Save
        </Button>
      </div>
    </div>
  );
};
