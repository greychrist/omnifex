import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ExternalLink } from "lucide-react";
import {
  parseElicitationSchema,
  initialElicitationValues,
  validateElicitation,
  toElicitationContent,
  type ElicitationField,
  type ElicitationValues,
} from "@/lib/elicitationForm";

/**
 * An MCP server's question, as main pushes it on `elicitation-request:<tabId>`
 * (see electron/services/sessions/elicitations.ts). Form mode asks for a
 * schema-shaped answer; URL mode asks the user to open a page — a sign-in,
 * typically — whose completion the server confirms on its own.
 */
export interface ElicitationRequest {
  requestId: string;
  serverName: string;
  message: string;
  mode: 'form' | 'url';
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}

interface ElicitationDialogProps {
  request: ElicitationRequest | null;
  onAccept: (requestId: string, content: Record<string, unknown> | undefined) => void;
  onDecline: (requestId: string) => void;
  /** Dismissed without an answer (Esc, click outside) — MCP's `cancel`. */
  onCancel: (requestId: string) => void;
  openUrl: (url: string) => Promise<void>;
}

export function ElicitationDialog({ request, onAccept, onDecline, onCancel, openUrl }: ElicitationDialogProps) {
  const fields = useMemo(
    () => (request?.mode === 'form' ? parseElicitationSchema(request.requestedSchema) : []),
    [request],
  );
  const [values, setValues] = useState<ElicitationValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Each request starts from its own schema defaults.
  useEffect(() => {
    setValues(initialElicitationValues(fields));
    setErrors({});
  }, [fields]);

  if (!request) return null;
  const serverLabel = request.displayName ?? request.serverName;

  const submit = () => {
    if (request.mode === 'url') {
      if (request.url) void openUrl(request.url).catch((e: unknown) => { console.error('[elicitation] openUrl failed:', e); });
      onAccept(request.requestId, undefined);
      return;
    }
    const found = validateElicitation(fields, values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onAccept(request.requestId, toElicitationContent(fields, values));
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(request.requestId); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {request.mode === 'url' && <ExternalLink className="h-4 w-4" />}
            {request.title ?? `${serverLabel} needs your input`}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap text-sm">
            {request.message}
          </DialogDescription>
        </DialogHeader>

        {request.mode === 'url' && request.url && (
          <div className="text-xs text-muted-foreground font-mono break-all bg-muted rounded px-3 py-2">
            {request.url}
          </div>
        )}

        {fields.length > 0 && (
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); submit(); }}
          >
            {fields.map((f) => (
              <FieldInput
                key={f.name}
                field={f}
                value={values[f.name]}
                error={errors[f.name]}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
              />
            ))}
          </form>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onDecline(request.requestId)}>
            Decline
          </Button>
          <Button onClick={submit}>
            {request.mode === 'url' ? 'Open in browser' : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: ElicitationField;
  value: string | boolean | string[] | undefined;
  error?: string;
  onChange: (v: string | boolean | string[]) => void;
}) {
  const id = `elicitation-${field.name}`;
  const label = (
    <span className="text-sm font-medium">
      {field.label}
      {field.required && <span className="text-destructive"> *</span>}
    </span>
  );

  let control: ReactNode;
  if (field.kind === 'boolean') {
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="flex items-center gap-2">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </label>
        {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      </div>
    );
  }
  if (field.kind === 'select') {
    control = (
      <select
        id={id}
        className="flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {field.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (field.kind === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    control = (
      <div id={id} className="flex flex-wrap gap-3">
        {field.options?.map((o) => (
          <label key={o.value} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={(e) =>
                onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))
              }
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  } else {
    const numeric = field.kind === 'number' || field.kind === 'integer';
    control = (
      <Input
        id={id}
        type={numeric ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'}
        step={field.kind === 'integer' ? 1 : undefined}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block">{label}</label>
      {control}
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
