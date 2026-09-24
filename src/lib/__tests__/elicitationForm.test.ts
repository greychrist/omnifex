import { describe, it, expect } from 'vitest';
import {
  parseElicitationSchema,
  initialElicitationValues,
  validateElicitation,
  toElicitationContent,
} from '@/lib/elicitationForm';

// MCP restricts an elicitation's requestedSchema to a flat object of
// primitives: string (optionally enum / oneOf / format), number, integer,
// boolean, and a string-enum array for multi-select. No nesting.

const schema = {
  type: 'object',
  properties: {
    repo: { type: 'string', title: 'Repository', description: 'owner/name', minLength: 3 },
    visibility: { type: 'string', enum: ['public', 'private'], enumNames: ['Public', 'Private'], default: 'private' },
    tier: { type: 'string', oneOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    ratio: { type: 'number' },
    draft: { type: 'boolean', default: true },
    labels: { type: 'array', items: { type: 'string', enum: ['bug', 'docs'] } },
  },
  required: ['repo', 'count'],
};

describe('parseElicitationSchema', () => {
  it('maps every primitive the MCP spec allows to a field', () => {
    const fields = parseElicitationSchema(schema);
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ['repo', 'text', true],
      ['visibility', 'select', false],
      ['tier', 'select', false],
      ['count', 'integer', true],
      ['ratio', 'number', false],
      ['draft', 'boolean', false],
      ['labels', 'multiselect', false],
    ]);
  });

  it('labels a field by its title, else its name', () => {
    const [repo, visibility] = parseElicitationSchema(schema);
    expect(repo.label).toBe('Repository');
    expect(repo.description).toBe('owner/name');
    expect(visibility.label).toBe('visibility');
  });

  it('reads enum labels from enumNames or from oneOf titles', () => {
    const fields = parseElicitationSchema(schema);
    expect(fields[1].options).toEqual([
      { value: 'public', label: 'Public' },
      { value: 'private', label: 'Private' },
    ]);
    expect(fields[2].options).toEqual([
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ]);
    expect(fields[6].options).toEqual([
      { value: 'bug', label: 'bug' },
      { value: 'docs', label: 'docs' },
    ]);
  });

  it('returns no fields for a missing or propertyless schema', () => {
    expect(parseElicitationSchema(undefined)).toEqual([]);
    expect(parseElicitationSchema({ type: 'object' })).toEqual([]);
  });
});

describe('initialElicitationValues', () => {
  it('starts from schema defaults, else empty', () => {
    const values = initialElicitationValues(parseElicitationSchema(schema));
    expect(values).toEqual({
      repo: '', visibility: 'private', tier: '', count: '', ratio: '', draft: true, labels: [],
    });
  });
});

describe('validateElicitation', () => {
  const fields = parseElicitationSchema(schema);

  it('flags missing required fields', () => {
    const errors = validateElicitation(fields, initialElicitationValues(fields));
    expect(errors).toEqual({ repo: 'Required', count: 'Required' });
  });

  it('enforces minLength and numeric bounds', () => {
    const values = { ...initialElicitationValues(fields), repo: 'ab', count: '11' };
    expect(validateElicitation(fields, values)).toEqual({
      repo: 'At least 3 characters',
      count: 'At most 10',
    });
  });

  it('rejects a non-integer for an integer field', () => {
    const values = { ...initialElicitationValues(fields), repo: 'a/b', count: '2.5' };
    expect(validateElicitation(fields, values)).toEqual({ count: 'Must be a whole number' });
  });

  it('passes a complete answer', () => {
    const values = { ...initialElicitationValues(fields), repo: 'a/b', count: '3' };
    expect(validateElicitation(fields, values)).toEqual({});
  });
});

describe('toElicitationContent', () => {
  it('types numbers, keeps booleans, and omits blank optional fields', () => {
    const fields = parseElicitationSchema(schema);
    const values = { ...initialElicitationValues(fields), repo: 'a/b', count: '3', labels: ['bug'] };
    expect(toElicitationContent(fields, values)).toEqual({
      repo: 'a/b',
      visibility: 'private',
      count: 3,
      draft: true,
      labels: ['bug'],
    });
  });
});
