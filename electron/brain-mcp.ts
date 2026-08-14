/**
 * The Brain MCP server.
 *
 * Spawned by the Claude CLI — never by OmniFex — as `process.execPath` with
 * ELECTRON_RUN_AS_NODE=1, so `better-sqlite3` loads against the Electron ABI it
 * was built for. System `node` would load a module built for the wrong ABI and
 * abort on open.
 *
 * It has no account concept and cannot enumerate vaults: it reads the one path
 * it was handed in `OMNIFEX_VAULT`. That is the entire isolation model. A
 * session under the personal account cannot reach the work vault because this
 * process was never told where that vault is — isolation is a property of the
 * process environment, not of a filter some future call site could forget.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createVault } from './services/brain/vault';
import { openVaultIndexReadOnly } from './services/brain/search';
import { createBrainMcpTools, type ToolResult } from './services/brain/mcp-tools';
import { NOTE_TYPES } from './services/brain/types';

/**
 * MCP content for a tool result. A failed tool is `isError`, never a thrown
 * exception: the CLI shows the model an error it can act on rather than
 * losing the server.
 */
function reply<T>(result: ToolResult<T>, body: (ok: T) => unknown) {
  if (!result.ok) {
    return { isError: true, content: [{ type: 'text' as const, text: result.error }] };
  }
  const { ok: _ok, ...rest } = result;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body(rest as T), null, 2) }],
  };
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

  const server = new McpServer({ name: 'omnifex-brain', version: '1.0.0' });

  // Nothing auto-injects the Brain into a session's context, so whether the
  // model reaches for these at all depends on how they describe themselves.
  // They state what the vault CONTAINS rather than how it works.
  server.registerTool(
    'brain_search',
    {
      description:
        "Search this account's OmniFex Brain: durable engineering knowledge distilled from " +
        'its own past Claude Code sessions — subsystems, decisions, constraints and the ' +
        'identifiers a developer would actually type. Use it before asking the user to ' +
        're-explain earlier work, and before assuming how something in this codebase came to be. ' +
        'Each hit carries the note text in `body`, so a result is usable as it stands — only ' +
        'follow up with brain_read where a hit sets `bodyTruncated`.',
      inputSchema: {
        query: z.string().describe('Search terms. Identifiers and file names work well.'),
        type: z.enum(NOTE_TYPES).optional().describe('Restrict to one note type.'),
        project: z
          .string()
          .optional()
          .describe('Wikilink to a project note, e.g. "[[Projects/omnifex]]".'),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    ({ query, type, project, limit }) =>
      reply(tools.search({ query, type, project, limit }), (r) => r.hits),
  );

  server.registerTool(
    'brain_read',
    {
      description:
        'Read one Brain note whole, by the vault-relative path a brain_search hit reports. ' +
        'Needed only when that hit set `bodyTruncated` — otherwise the search result already ' +
        'held the entire note and this call returns the same text again.',
      inputSchema: {
        path: z.string().describe('Vault-relative path, e.g. "Subsystems/Queue.md".'),
      },
    },
    ({ path }) => reply(tools.read({ path }), (r) => r.note),
  );

  server.registerTool(
    'brain_remember',
    {
      description:
        "Record a durable fact into this account's Brain. Use it for what will still matter " +
        'in six months — a decision and the reason behind it, a constraint, a gotcha that ' +
        'cost time. The text is queued and becomes a note after the current session ends; ' +
        'it is not written immediately.',
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
