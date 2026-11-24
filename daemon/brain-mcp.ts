// Runs on the daemon's own node (better-sqlite3's ABI), never PATH node.
// Isolation is the environment: it reads only OMNIFEX_VAULT. Never add a vault parameter.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createVault } from './services/brain/vault';
import { openVaultIndexReadOnly } from './services/brain/search';
import {
  createBrainMcpTools,
  renderNote,
  renderSearchResult,
  MCP_DEFAULT_LIMIT,
  type ToolResult,
} from './services/brain/mcp-tools';
import { brainInstructions } from './services/brain/instructions';
import { NOTE_TYPES } from './services/brain/types';

/** A failed tool is `isError`, never a throw: a throw loses the server. */
function reply<T>(result: ToolResult<T>, body: (ok: T) => unknown) {
  if (!result.ok) {
    return { isError: true, content: [{ type: 'text' as const, text: result.error }] };
  }
  const { ok: _ok, ...rest } = result;
  const rendered = body(rest as T);
  return {
    content: [
      {
        type: 'text' as const,
        // Markdown verbatim: JSON-escaping newlines costs a fifth of the response.
        text: typeof rendered === 'string' ? rendered : JSON.stringify(rendered, null, 2),
      },
    ],
  };
}

/** Every failure yields the generic text: a missing index must not stop `brain_read`. */
function instructionsFor(dbPath: string): string {
  let cwd: string | null = null;
  try {
    cwd = process.cwd();
  } catch {
    // A deleted cwd throws; unattributed is still useful.
  }
  try {
    const index = openVaultIndexReadOnly(dbPath);
    try {
      return brainInstructions(cwd, index.projectCounts());
    } finally {
      index.close();
    }
  } catch {
    return brainInstructions(cwd, []);
  }
}

function main(): Promise<void> {
  const vaultRoot = process.env.OMNIFEX_VAULT;
  if (!vaultRoot) {
    process.stderr.write('brain-mcp: OMNIFEX_VAULT is required\n');
    process.exit(1);
  }
  const dbPath = process.env.OMNIFEX_BRAIN_DB ?? join(vaultRoot, '.omnifex', 'index.db');

  const tools = createBrainMcpTools({
    vault: createVault(vaultRoot),
    openIndex: () => openVaultIndexReadOnly(dbPath),
    captureDir: join(vaultRoot, '.omnifex', 'capture'),
    newId: () => randomUUID(),
    now: () => new Date(),
  });

  // `instructions` is what drives invocation; read instructions.ts before reintroducing a SessionStart hook.
  const server = new McpServer(
    { name: 'omnifex-brain', version: '1.0.0' },
    { instructions: instructionsFor(dbPath) },
  );

  // Descriptions say what a tool IS; when-to-call lives only in `instructions`, or every tool pays for it.
  server.registerTool(
    'brain_search',
    {
      description:
        "Search this account's OmniFex Brain — durable knowledge distilled from its own past " +
        'Claude Code sessions. Returns matching notes as markdown, best match first, with the ' +
        'note text inline.',
      inputSchema: {
        query: z.string().describe('Identifiers, file paths or error text. Two to five terms.'),
        type: z.enum(NOTE_TYPES).optional().describe('Restrict to one note type.'),
        project: z
          .string()
          .optional()
          .describe('Wikilink to a project note, e.g. "[[Projects/omnifex]]".'),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe(`Hits to return. Defaults to ${String(MCP_DEFAULT_LIMIT)}.`),
      },
    },
    ({ query, type, project, limit }) =>
      reply(tools.search({ query, type, project, limit }), (r) => renderSearchResult(query, r.hits)),
  );

  server.registerTool(
    'brain_read',
    {
      description:
        'Read one Brain note whole, by the vault-relative path a brain_search hit reports. ' +
        'Needed only for a hit the search marked as truncated — otherwise that result already ' +
        'held the entire note and this returns the same text again.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "Subsystems/Queue.md".'),
      },
    },
    ({ path }) => reply(tools.read({ path }), (r) => renderNote(path, r.note)),
  );

  server.registerTool(
    'brain_remember',
    {
      description:
        "Record a durable fact into this account's Brain. The text is queued and becomes a " +
        'note after the current session ends; it is not written immediately.',
      inputSchema: {
        text: z.string().describe('The fact, in prose. Include why, not only what.'),
        project: z.string().optional().describe('Project this belongs to, e.g. "omnifex".'),
      },
    },
    ({ text, project }) =>
      reply(tools.remember({ text, project, cwd: process.cwd() }), (r) => ({
        captured: true,
        id: r.id,
        status: 'queued for indexing',
      })),
  );

  return server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`brain-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
