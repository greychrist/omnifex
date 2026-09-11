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
import {
  createBrainMcpTools,
  renderNote,
  renderSearchResult,
  MCP_DEFAULT_LIMIT,
  type ToolResult,
} from './services/brain/mcp-tools';
import { brainInstructions } from './services/brain/instructions';
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
  const rendered = body(rest as T);
  return {
    content: [
      {
        type: 'text' as const,
        // Notes are markdown, and nothing on the other side parses this — a
        // model reads it. JSON-encoding a note spends a fifth of the response
        // escaping the newlines it is made of.
        text: typeof rendered === 'string' ? rendered : JSON.stringify(rendered, null, 2),
      },
    ],
  };
}

/**
 * What the server tells every session about itself, computed once at startup.
 *
 * The CLI spawns this process in the session's working directory, which is what
 * makes a repo-specific directive possible from in here at all — the same fact
 * `brain_remember` already relies on to stamp a capture's `cwd`.
 *
 * Every failure is silent and yields the generic text. The Brain is auxiliary:
 * a missing index must not stop the server that still serves `brain_read`.
 */
function instructionsFor(dbPath: string): string {
  let cwd: string | null = null;
  try {
    cwd = process.cwd();
  } catch {
    // A deleted working directory throws here. Unattributed is still useful.
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

  // `instructions` is the whole reason a session reaches for any of this. It
  // reaches the model whether or not a tool is ever called, and it replaces the
  // SessionStart hook that used to do this job from outside the app — see
  // services/brain/instructions.ts for why that was worth collapsing.
  const server = new McpServer(
    { name: 'omnifex-brain', version: '1.0.0' },
    { instructions: instructionsFor(dbPath) },
  );

  // The descriptions state what each tool IS, and leave when-to-call to the
  // instructions above. Repeating the trigger conditions here would pay for
  // them three times — once per tool — in every session.
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
