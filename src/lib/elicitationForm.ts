// MCP elicitation form model.
//
// An MCP server's `elicitation/create` in form mode carries a requestedSchema
// the spec restricts to a flat object of primitives — string (optionally
// `enum` + `enumNames`, `oneOf` of `{const,title}`, `format`), number,
// integer, boolean, and a string-enum array for multi-select. No nesting,
// which is what makes a generic form honest. The CLI relays the schema
// untouched; this turns it into fields, validates, and builds the `content`
// object the answer carries.

export type ElicitationFieldKind = 'text' | 'select' | 'number' | 'integer' | 'boolean' | 'multiselect';

export interface ElicitationOption {
  value: string;
  label: string;
}

export interface ElicitationField {
  name: string;
  kind: ElicitationFieldKind;
  label: string;
  description?: string;
  required: boolean;
  options?: ElicitationOption[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

/** Form state. Numbers are held as the typed string until submit. */
export type ElicitationValues = Record<string, string | boolean | string[]>;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function enumOptions(p: Json): ElicitationOption[] | undefined {
  if (Array.isArray(p.enum)) {
    const names = Array.isArray(p.enumNames) ? p.enumNames : [];
    return p.enum.map((v, i) => ({ value: String(v), label: str(names[i]) ?? String(v) }));
  }
  const choices = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null;
  if (choices) {
    return choices.filter(isObj).map((c) => ({
      value: String(c.const),
      label: str(c.title) ?? String(c.const),
    }));
  }
  return undefined;
}

export function parseElicitationSchema(schema: unknown): ElicitationField[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);

  return Object.entries(schema.properties).map(([name, raw]) => {
    const p = isObj(raw) ? raw : {};
    const base = {
      name,
      label: str(p.title) ?? name,
      required: required.has(name),
      ...(str(p.description) !== undefined && { description: str(p.description) }),
      ...(p.default !== undefined && { default: p.default }),
    };

    if (p.type === 'boolean') return { ...base, kind: 'boolean' };
    if (p.type === 'number' || p.type === 'integer') {
      return {
        ...base,
        kind: p.type,
        ...(num(p.minimum) !== undefined && { minimum: num(p.minimum) }),
        ...(num(p.maximum) !== undefined && { maximum: num(p.maximum) }),
      };
    }
    if (p.type === 'array') {
      const items = isObj(p.items) ? p.items : {};
      return { ...base, kind: 'multiselect', options: enumOptions(items) ?? [] };
    }
    const options = enumOptions(p);
    if (options) return { ...base, kind: 'select', options };
    // Anything else — the spec's `string`, or a type it does not allow —
    // is asked for as text rather than dropped from the form.
    return {
      ...base,
      kind: 'text',
      ...(str(p.format) !== undefined && { format: str(p.format) }),
      ...(num(p.minLength) !== undefined && { minLength: num(p.minLength) }),
      ...(num(p.maxLength) !== undefined && { maxLength: num(p.maxLength) }),
    };
  });
}

export function initialElicitationValues(fields: ElicitationField[]): ElicitationValues {
  const values: ElicitationValues = {};
  for (const f of fields) {
    if (f.kind === 'boolean') values[f.name] = f.default === true;
    else if (f.kind === 'multiselect') values[f.name] = Array.isArray(f.default) ? f.default.map(String) : [];
    else values[f.name] = f.default === undefined ? '' : String(f.default);
  }
  return values;
}

function isBlank(v: string | boolean | string[] | undefined): boolean {
  if (Array.isArray(v)) return v.length === 0;
  return v === undefined || v === '';
}

/** Field name → message, for every field that would not survive submit. */
export function validateElicitation(fields: ElicitationField[], values: ElicitationValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (isBlank(v)) {
      // A boolean is never blank; an unticked required box is a valid `false`.
      if (f.required) errors[f.name] = 'Required';
      continue;
    }
    if (f.kind === 'text' && typeof v === 'string') {
      if (f.minLength !== undefined && v.length < f.minLength) errors[f.name] = `At least ${f.minLength} characters`;
      else if (f.maxLength !== undefined && v.length > f.maxLength) errors[f.name] = `At most ${f.maxLength} characters`;
    }
    if ((f.kind === 'number' || f.kind === 'integer') && typeof v === 'string') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[f.name] = 'Must be a number';
      else if (f.kind === 'integer' && !Number.isInteger(n)) errors[f.name] = 'Must be a whole number';
      else if (f.minimum !== undefined && n < f.minimum) errors[f.name] = `At least ${f.minimum}`;
      else if (f.maximum !== undefined && n > f.maximum) errors[f.name] = `At most ${f.maximum}`;
    }
  }
  return errors;
}

/** The answer's `content`: typed values, blank optional fields left out. */
export function toElicitationContent(fields: ElicitationField[], values: ElicitationValues): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (isBlank(v)) continue;
    content[f.name] = (f.kind === 'number' || f.kind === 'integer') ? Number(v) : v;
  }
  return content;
}
