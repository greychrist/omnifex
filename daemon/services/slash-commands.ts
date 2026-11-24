import fs from 'node:fs';
import path from 'node:path';

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

interface ParsedCommand {
  description: string;
  allowed_tools: string;
  otherFrontmatter: string[];
  content: string;
}

/** The CLI reads `allowed-tools`; legacy `allowed_tools` is accepted on read and rewritten hyphenated. */
const OWNED_KEYS = new Set(['description', 'allowed-tools', 'allowed_tools']);

const FRONTMATTER_KEY_RE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;

function parseFrontmatter(input: string): ParsedCommand {
  // Strip a BOM first, or the file falls to the no-frontmatter path (the CLI strips it too). Escaped so it stays visible.
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

  // Track the open key so nested blocks survive and a dropped key takes its continuation lines.
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
        allowed_tools = value;
      }
      continue;
    }
    if (!inOwnedKey) otherFrontmatter.push(line);
  }

  return { description, allowed_tools, otherFrontmatter, content: body };
}

/** Preserves unmodelled keys: the CLI reads many more, and dropping `model:` changes the model a command runs on. */
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

/** A Dirent describes the link itself: follow symlinks, or linked skills/commands vanish. Broken links are skipped. */
function entryIs(dir: string, entry: fs.Dirent, kind: 'file' | 'directory'): boolean {
  if (kind === 'file' ? entry.isFile() : entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    const stat = fs.statSync(path.join(dir, entry.name));
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
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
    if (!entry.name.endsWith('.md') || !entryIs(dir, entry, 'file')) continue;
    const filePath = path.join(dir, entry.name);
    const cmd = commandFromFile(filePath, scope, namespace);
    if (cmd) {
      commands.push(cmd);
    }
  }

  return commands;
}

/** Emitted as scoped pseudo-commands: the CLI's SlashCommand carries no source, so the picker's dedup re-tags them. */
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
    if (!entryIs(dir, entry, 'directory')) continue;
    const manifestPath = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(manifestPath)) continue;
    // Name from the folder, as the CLI reports it, not the manifest's basename.
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

export function createSlashCommandsService(): SlashCommandsService {
  // No default-account fallback to ~/.claude: the caller passes the resolved config_dir.
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

    if (configDir) {
      commands.push(...scanDirectory(getCommandsDir(configDir), 'user', 'user'));

      const userSkillsDir = path.join(configDir, 'skills');
      commands.push(...scanSkillsDirectory(userSkillsDir, 'user', 'user'));
    }

    if (projectPath) {
      const projectCommandsDir = path.join(projectPath, '.claude', 'commands');
      commands.push(...scanDirectory(projectCommandsDir, 'project', 'project'));

      const projectSkillsDir = path.join(projectPath, '.claude', 'skills');
      commands.push(...scanSkillsDirectory(projectSkillsDir, 'project', 'project'));
    }

    return commands;
  }

  function get(commandId: string, configDir?: string): SlashCommand {
    const parts = commandId.split(':');
    if (parts.length < 3) {
      throw new Error(`Invalid command id: ${commandId}`);
    }
    const [scope, namespace, name] = parts;

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

    // Re-read the file so unmodelled keys survive the round trip.
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
    } catch (e) {
      throw new Error(`Could not delete command: ${(e as Error).message}`);
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
