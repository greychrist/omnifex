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
  content: string;
}

function parseFrontmatter(raw: string): ParsedCommand {
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { description: '', allowed_tools: '', content: raw.trim() };
  }

  const yamlBlock = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();

  let description = '';
  let allowed_tools = '';

  for (const line of yamlBlock.split('\n')) {
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      description = descMatch[1].trim();
      continue;
    }
    const toolsMatch = line.match(/^allowed_tools:\s*(.*)$/);
    if (toolsMatch) {
      allowed_tools = toolsMatch[1].trim();
    }
  }

  return { description, allowed_tools, content: body };
}

function renderFrontmatter(params: {
  description: string;
  allowed_tools: string;
  content: string;
}): string {
  return `---\ndescription: ${params.description}\nallowed_tools: ${params.allowed_tools}\n---\n${params.content}\n`;
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
 * `SKILL.md` with frontmatter (`name`, `description`). The Claude Agent SDK
 * exposes them alongside built-in slash commands, but its `SlashCommand`
 * shape (`name` / `description` / `argumentHint`) carries no source info,
 * so the renderer can't tell project skills apart from SDK defaults.
 *
 * Emitting them here as project- or user-scoped pseudo-commands lets the
 * picker's dedup (custom commands win over SDK defaults) re-tag them with
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
    // matching how the SDK reports the skill — not from the manifest's
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
      // can re-tag SDK-reported skills out of the "default" bucket.
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
    const fileContent = renderFrontmatter({
      description,
      allowed_tools: allowedTools,
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
