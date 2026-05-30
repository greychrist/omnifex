import React from "react";
import { Plus, X } from "lucide-react";
import type { Category, MatchCondition, MatchOp } from "@/lib/messageRenderingConfig";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { flattenExamplePaths, formatMatchValue } from "./matchFormat";
import { cn } from "@/lib/utils";

const OPS: { value: MatchOp; label: string }[] = [
  { value: "eq", label: "eq" },
  { value: "contains", label: "contains" },
  { value: "regex", label: "regex" },
];

/** Editing model: the value is held as the raw input text and parsed into a
 *  typed JSON literal only on save (and seeded from the example on a click). */
interface EditCondition {
  path: string;
  op: MatchOp;
  valueText: string;
}

/**
 * Parse a value-field string into a typed JSON literal. `true` / `false` /
 * `null` and numbers are typed; a `"quoted"` form is an explicit string; any
 * other bare text is taken as a string for convenience.
 */
export function parseLiteral(text: string): MatchCondition["value"] {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t) as string; } catch { /* fall through */ }
  }
  return text;
}

interface OverrideMatchDialogProps {
  open: boolean;
  mode: "create" | "edit";
  category: Category;
  categoryLabel: string;
  initialLabel: string;
  initialMatch: MatchCondition[];
  exampleRaw: unknown;
  onSave: (data: { label: string; match: MatchCondition[] }) => void;
  onCancel: () => void;
}

export const OverrideMatchDialog: React.FC<OverrideMatchDialogProps> = ({
  open,
  mode,
  category,
  categoryLabel,
  initialLabel,
  initialMatch,
  exampleRaw,
  onSave,
  onCancel,
}) => {
  const [label, setLabel] = React.useState(initialLabel);
  const [conditions, setConditions] = React.useState<EditCondition[]>(() =>
    initialMatch.map((c) => ({ path: c.path, op: c.op, valueText: formatMatchValue(c.value) })),
  );

  // Reset the form whenever the dialog (re)opens for a different target.
  React.useEffect(() => {
    if (!open) return;
    setLabel(initialLabel);
    setConditions(initialMatch.map((c) => ({ path: c.path, op: c.op, valueText: formatMatchValue(c.value) })));
  }, [open, initialLabel, initialMatch]);

  const examplePaths = React.useMemo(() => flattenExamplePaths(exampleRaw), [exampleRaw]);

  const addCondition = (path = "", valueText = "") => {
    setConditions((cs) => [...cs, { path, op: "eq", valueText }]);
  };
  const updateCondition = (idx: number, patch: Partial<EditCondition>) => {
    setConditions((cs) => cs.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const removeCondition = (idx: number) => {
    setConditions((cs) => cs.filter((_, i) => i !== idx));
  };

  const handleSave = () => {
    const match: MatchCondition[] = conditions
      .filter((c) => c.path.trim() !== "")
      .map((c) => ({ path: c.path.trim(), op: c.op, value: parseLiteral(c.valueText) }));
    onSave({ label: label.trim() || initialLabel || category, match });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Add override" : "Edit override"}</DialogTitle>
          <DialogDescription>
            Scoped to the <strong>{categoryLabel}</strong> category — it matches only
            messages the classifier put there, and inherits that category's style.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* Label */}
          <div className="space-y-1.5">
            <Label htmlFor="override-label">Label</Label>
            <Input
              id="override-label"
              value={label}
              onChange={(e) => { setLabel(e.target.value); }}
              placeholder="e.g. Bash tool calls"
              aria-label="Override label"
            />
          </div>

          {/* Conditions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Match conditions</Label>
              <span
                className="text-[10px] rounded-full border border-border px-1.5 py-0.5 text-muted-foreground font-mono"
                title="Number of conditions — more conditions win in the cascade"
                aria-label={`${conditions.length} conditions`}
              >
                {conditions.length} {conditions.length === 1 ? "condition" : "conditions"}
              </span>
            </div>
            {conditions.length === 0 && (
              <p className="text-[11px] text-muted-foreground/70 italic">
                No conditions — this rule matches every {categoryLabel} message.
              </p>
            )}
            {conditions.map((c, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <Input
                  value={c.path}
                  onChange={(e) => { updateCondition(idx, { path: e.target.value }); }}
                  placeholder="path (e.g. subtype)"
                  aria-label={`Condition ${idx + 1} path`}
                  className="font-mono text-xs h-8 flex-1 min-w-0"
                />
                <Select value={c.op} onValueChange={(v) => { updateCondition(idx, { op: v as MatchOp }); }}>
                  <SelectTrigger aria-label={`Condition ${idx + 1} operator`} className="h-8 w-28 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={c.valueText}
                  onChange={(e) => { updateCondition(idx, { valueText: e.target.value }); }}
                  placeholder={'value (e.g. "error")'}
                  aria-label={`Condition ${idx + 1} value`}
                  className="font-mono text-xs h-8 flex-1 min-w-0"
                />
                <button
                  type="button"
                  onClick={() => { removeCondition(idx); }}
                  aria-label={`Remove condition ${idx + 1}`}
                  className="shrink-0 text-muted-foreground/60 hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => { addCondition(); }}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> Add condition
            </button>
          </div>

          {/* Example JSON — click a field to seed a condition */}
          <div className="space-y-1.5 pt-2 border-t border-border">
            <Label className="text-caption">Example message — click a field to add a condition</Label>
            <div className="rounded-md border border-border bg-muted/20 p-2 max-h-48 overflow-y-auto flex flex-wrap gap-1">
              {examplePaths.map((ep) => (
                <button
                  key={ep.path}
                  type="button"
                  onClick={() => { addCondition(ep.path, formatMatchValue(ep.value)); }}
                  title={`Add: ${ep.path} eq ${formatMatchValue(ep.value)}`}
                  className={cn(
                    "rounded border border-border/60 bg-background px-1.5 py-0.5",
                    "font-mono text-[10px] text-foreground/80 hover:bg-accent hover:text-foreground",
                  )}
                >
                  {ep.path}
                  <span className="text-muted-foreground/60"> = {formatMatchValue(ep.value)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={label.trim() === ""}>
            {mode === "create" ? "Add override" : "Save rules"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
