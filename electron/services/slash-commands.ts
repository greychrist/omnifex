import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SlashCommand {
  id: string;
  name: string;
  full_command: string;
  namespace: string;
  scope: string;
  content: string;
  description: string;
  allowed_tools: string;
  file_path: string;
}

export interface SaveParams {
  scope: string;
  name: string;
  namespace: string;
  content: string;
  description: string;
  allowedTools: string;
  projectPath?: string;
  configDir?: string;
}

export interface SlashCommandsService {
  list(projectPath?: string, configDir?: string): SlashCommand[];
  get(commandId: string, configDir?: string): SlashCommand;
  save(params: SaveParams): SlashCommand;
  delete(commandId: string, projectPath?: string, configDir?: string): string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedCommand {
  description: string;
  allowed_tools: string;
  /**
   * Frontmatter lines for keys this service does not model, verbatim and in
   * their original order, so `save` can put them back. See `renderFrontmatter`.
   */
  otherFrontmatter: string[];
  content: string;
}

/**
 * Frontmatter keys this service parses into its own fields and re-emits from
 * them. Everything else is preserved untouched.
 *
 * `allowed-tools` is the spelling Claude Code reads; `allowed_tools` is what
 * OmniFex used to write and is still accepted on the way in so existing files
 * keep working. Both are owned, so a file carrying the legacy key is rewritten
 * to the hyphenated one rather than ending up with both.
 */
const OWNED_KEYS = new Set(['description', 'allowed-tools', 'allowed_tools']);

/** A `key:` line at the top level of a YAML block (not an indented child). */
const FRONTMATTER_KEY_RE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;

function parseFrontmatter(input: string): ParsedCommand {
  // Strip a leading UTF-8 BOM before anchoring on `---`. Editors add one
  // routinely and it is invisible, so without this the file falls down the
  // no-frontmatter path: empty description, and the raw `---` block leaking
  // into the body. Claude Code fixed the same bug on its side in 2.1.239, so a
  // file the CLI now honours has to read the same way here. Written as an
  // escape rather than a literal BOM so it stays visible in the source.
  const raw = input.replace(/^\uFEFF/, '');
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!frontmatterMatch) {
    return { description: '', allowed_tools: '', otherFrontmatter: [], content: raw.trim() };
  }

  const yamlBlock = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();

  let description = '';
  let allowed_tools = '';
  let sawHyphenatedTools = false;
  const otherFrontmatter: string[] = [];

  // A top-level `key:` line opens a key; anything indented or blank after it
  // belongs to that key's value. Tracking which key is open is what lets a
  // nested block (`hooks:` with children) survive intact while a dropped
  // key takes its continuation lines with it.
  let inOwnedKey = false;

  for (const line of yamlBlock.split('\n')) {
    const keyMatch = FRONTMATTER_KEY_RE.exec(line);
    if (keyMatch && !/^[ \t]/.test(line)) {
      const key = keyMatch[1];
      const value = keyMatch[2].trim();
      inOwnedKey = OWNED_KEYS.has(key);
      if (!inOwnedKey) {
        otherFrontmatter.push(line);
      } else if (key === 'description') {
        description = value;
      } else if (key === 'allowed-tools') {
        allowed_tools = value;
        sawHyphenatedTools = true;
      } else if (!sawHyphenatedTools) {
        // Legacy `allowed_tools`. The hyphenated key wins if the file has both.
        allowed_tools = value;
      }
      continue;
    }
    // Continuation of whatever key is open (or stray text before the first).
    if (!inOwnedKey) otherFrontmatter.push(line);
  }

  return { description, allowed_tools, otherFrontmatter, content: body };
}

/**
 * Write a command file back out, keeping frontmatter this service doesn't model.
 *
 * Claude Code reads far more keys than the two the editor exposes — `model`,
 * `effort`, `argument-hint`, `arguments`, `disable-model-invocation`,
 * `user-invocable`, `shell`, `when_to_use`, `hooks`, `agent` and more. Saving
 * used to rebuild the block from `description` + tools alone, silently deleting
 * every one of them. `model:` in particular stopped being harmless to drop in
 * CLI 2.1.259, which began honouring it in interactive sessions: losing it
 * changes the model the command runs on.
 *
 * The owned keys lead so the file still reads the way the editor presents it.
 */
function renderFrontmatter(params: {
  description: string;
  allowed_tools: string;
  otherFrontmatter?: string[];
  content: string;
}): string {
  const lines = [
    `description: ${params.description}`,
    `allowed-tools: ${params.allowed_tools}`,
    ...(params.otherFrontmatter ?? []),
  ];
  return `---\n${lines.join('\n')}\n---\n${params.content}\n`;
}

function commandFromFile(
  filePath: string,
  scope: string,
  namespace: string
): SlashCommand | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { description, allowed_tools, content } = parseFrontmatter(raw);
  const fileName = path.basename(filePath, '.md');
  const id = `${scope}:${namespace}:${fileName}`;

  return {
    id,
    name: fileName,
    full_command: `/${fileName}`,
    namespace,
    scope,
    content,
    description,
    allowed_tools,
    file_path: filePath,
  };
}

function scanDirectory(
  dir: string,
  scope: string,
  namespace: string
): SlashCommand[] {
  const commands: SlashCommand[] = [];
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return commands;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(dir, entry.name);
    const cmd = commandFromFile(filePath, scope, namespace);
    if (cmd) {
      commands.push(cmd);
    }
  }

  return commands;
}

/**
 * Scan a `.claude/skills/` directory. Skills are folders, each containing a
 * `SKILL.md` with frontmatter (`name`, `description`). The CLI exposes them
 * alongside built-in slash commands, but its `SlashCommand` shape
 * (`name` / `description` / `argumentHint`) carries no source info, so the
 * renderer can't tell project skills apart from CLI defaults.
 *
 * Emitting them here as project- or user-scoped pseudo-commands lets the
 * picker's dedup (custom commands win over CLI defaults) re-tag them with
 * the correct scope.
 */
function scanSkillsDirectory(
  dir: string,
  scope: string,
  namespace: string
): SlashCommand[] {
  const commands: SlashCommand[] = [];
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return commands;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(manifestPath)) continue;
    // Reuse commandFromFile so frontmatter parsing stays in one place. The
    // `name` (and thus `full_command`) is taken from the folder name —
    // matching how the CLI reports the skill — not from the manifest's
    // basename ("SKILL").
    const cmd = commandFromFile(manifestPath, scope, namespace);
    if (cmd) {
      commands.push({
        ...cmd,
        name: entry.name,
        full_command: `/${entry.name}`,
        id: `${scope}:${namespace}:${entry.name}`,
      });
    }
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSlashCommandsService(): SlashCommandsService {
  // configDir is required for every operation that scans user-scoped commands
  // / skills. There is no default-account fallback to ~/.claude — the caller
  // must pass the resolved account's config_dir explicitly.
  function getCommandsDir(configDir?: string): string {
    if (!configDir) {
      throw new Error(
        'slash-commands: configDir is required. The renderer must pass ' +
        "the resolved account's config_dir; there is no default-account fallback.",
      );
    }
    return path.join(configDir, 'commands');
  }

  function list(projectPath?: string, configDir?: string): SlashCommand[] {
    const commands: SlashCommand[] = [];

    // Global (user) commands — only attempted when the caller resolved a
    // configDir. Without one we can't list user-scoped commands at all
    // (no default-account fallback). Project-local commands below are
    // always scanned because they're on the project path itself.
    if (configDir) {
      commands.push(...scanDirectory(getCommandsDir(configDir), 'user', 'user'));

      // Global (user) skills — emitted as user-scoped so the picker's dedup
      // can re-tag CLI-reported skills out of the "default" bucket.
      const userSkillsDir = path.join(configDir, 'skills');
      commands.push(...scanSkillsDirectory(userSkillsDir, 'user', 'user'));
    }

    // Project-local commands
    if (projectPath) {
      const projectCommandsDir = path.join(projectPath, '.claude', 'commands');
      commands.push(...scanDirectory(projectCommandsDir, 'project', 'project'));

      // Project-local skills
      const projectSkillsDir = path.join(projectPath, '.claude', 'skills');
      commands.push(...scanSkillsDirectory(projectSkillsDir, 'project', 'project'));
    }

    return commands;
  }

  function get(commandId: string, configDir?: string): SlashCommand {
    // commandId format: scope:namespace:name
    const parts = commandId.split(':');
    if (parts.length < 3) {
      throw new Error(`Invalid command id: ${commandId}`);
    }
    const [scope, namespace, name] = parts;

    // For user-scoped commands use the (possibly per-call) commands dir.
    // For project-scoped commands we don't have the project path in the id,
    // so we fall through to the same dir as a best-effort lookup.
    const dir = getCommandsDir(configDir);

    const filePath = path.join(dir, `${name}.md`);
    const cmd = commandFromFile(filePath, scope, namespace);
    if (!cmd) {
      throw new Error(`Command not found: ${commandId}`);
    }
    return cmd;
  }

  function save(params: SaveParams): SlashCommand {
    const { scope, name, namespace, content, description, allowedTools, projectPath, configDir } =
      params;

    let dir: string;
    if (scope === 'project' && projectPath) {
      dir = path.join(projectPath, '.claude', 'commands');
    } else {
      dir = getCommandsDir(configDir);
    }

    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${name}.md`);

    // Re-read the file being overwritten so keys the editor doesn't model
    // survive the round trip. Missing file (a new command) means nothing to
    // preserve.
    let otherFrontmatter: string[] = [];
    try {
      otherFrontmatter = parseFrontmatter(fs.readFileSync(filePath, 'utf-8')).otherFrontmatter;
    } catch {
      otherFrontmatter = [];
    }

    const fileContent = renderFrontmatter({
      description,
      allowed_tools: allowedTools,
      otherFrontmatter,
      content,
    });

    fs.writeFileSync(filePath, fileContent, 'utf-8');

    const id = `${scope}:${namespace}:${name}`;
    return {
      id,
      name,
      full_command: `/${name}`,
      namespace,
      scope,
      content,
      description,
      allowed_tools: allowedTools,
      file_path: filePath,
    };
  }

  function deleteCommand(commandId: string, projectPath?: string, configDir?: string): string {
    // commandId format: scope:namespace:name
    const parts = commandId.split(':');
    if (parts.length < 3) {
      throw new Error(`Invalid command id: ${commandId}`);
    }
    const [scope, , name] = parts;

    let filePath: string;
    if (scope === 'project' && projectPath) {
      filePath = path.join(projectPath, '.claude', 'commands', `${name}.md`);
    } else {
      filePath = path.join(getCommandsDir(configDir), `${name}.md`);
    }

    try {
      fs.unlinkSync(filePath);
    } catch (e: any) {
      throw new Error(`Could not delete command: ${e.message}`);
    }

    return `Deleted command: ${commandId}`;
  }

  return {
    list,
    get,
    save,
    delete: deleteCommand,
  };
}
