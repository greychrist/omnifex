import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SlashCommand {
  id: string;
  name: string;
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
}

export interface SlashCommandsService {
  list(projectPath?: string): SlashCommand[];
  get(commandId: string): SlashCommand;
  save(params: SaveParams): SlashCommand;
  delete(commandId: string, projectPath?: string): string;
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSlashCommandsService(configDir: string): SlashCommandsService {
  const globalCommandsDir = path.join(configDir, 'commands');

  function list(projectPath?: string): SlashCommand[] {
    const commands: SlashCommand[] = [];

    // Global commands
    commands.push(...scanDirectory(globalCommandsDir, 'user', 'user'));

    // Project-local commands
    if (projectPath) {
      const projectCommandsDir = path.join(projectPath, '.claude', 'commands');
      commands.push(...scanDirectory(projectCommandsDir, 'project', 'project'));
    }

    return commands;
  }

  function get(commandId: string): SlashCommand {
    // commandId format: scope:namespace:name
    const parts = commandId.split(':');
    if (parts.length < 3) {
      throw new Error(`Invalid command id: ${commandId}`);
    }
    const [scope, namespace, name] = parts;

    let dir: string;
    if (scope === 'project') {
      // We don't have a project path here — search the global dir
      // For project commands, id encodes which dir via the file_path scanning
      dir = globalCommandsDir; // fallback
    } else {
      dir = globalCommandsDir;
    }

    const filePath = path.join(dir, `${name}.md`);
    const cmd = commandFromFile(filePath, scope, namespace);
    if (!cmd) {
      throw new Error(`Command not found: ${commandId}`);
    }
    return cmd;
  }

  function save(params: SaveParams): SlashCommand {
    const { scope, name, namespace, content, description, allowedTools, projectPath } = params;

    let dir: string;
    if (scope === 'project' && projectPath) {
      dir = path.join(projectPath, '.claude', 'commands');
    } else {
      dir = globalCommandsDir;
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
      namespace,
      scope,
      content,
      description,
      allowed_tools: allowedTools,
      file_path: filePath,
    };
  }

  function deleteCommand(commandId: string, projectPath?: string): string {
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
      filePath = path.join(globalCommandsDir, `${name}.md`);
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
