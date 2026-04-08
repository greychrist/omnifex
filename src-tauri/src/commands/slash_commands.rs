use anyhow::{Context, Result};
use log::{debug, error, info};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Represents a custom slash command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    /// Unique identifier for the command (derived from file path)
    pub id: String,
    /// Command name (without prefix)
    pub name: String,
    /// Full command with prefix (e.g., "/project:optimize")
    pub full_command: String,
    /// Command scope: "project" or "user"
    pub scope: String,
    /// Optional namespace (e.g., "frontend" in "/project:frontend:component")
    pub namespace: Option<String>,
    /// Path to the markdown file
    pub file_path: String,
    /// Command content (markdown body)
    pub content: String,
    /// Optional description from frontmatter
    pub description: Option<String>,
    /// Allowed tools from frontmatter
    pub allowed_tools: Vec<String>,
    /// Whether the command has bash commands (!)
    pub has_bash_commands: bool,
    /// Whether the command has file references (@)
    pub has_file_references: bool,
    /// Whether the command uses $ARGUMENTS placeholder
    pub accepts_arguments: bool,
}

/// YAML frontmatter structure
#[derive(Debug, Deserialize)]
struct CommandFrontmatter {
    #[serde(rename = "allowed-tools")]
    allowed_tools: Option<Vec<String>>,
    description: Option<String>,
}

/// Parse a markdown file with optional YAML frontmatter
fn parse_markdown_with_frontmatter(content: &str) -> Result<(Option<CommandFrontmatter>, String)> {
    let lines: Vec<&str> = content.lines().collect();

    // Check if the file starts with YAML frontmatter
    if lines.is_empty() || lines[0] != "---" {
        // No frontmatter
        return Ok((None, content.to_string()));
    }

    // Find the end of frontmatter
    let mut frontmatter_end = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if *line == "---" {
            frontmatter_end = Some(i);
            break;
        }
    }

    if let Some(end) = frontmatter_end {
        // Extract frontmatter
        let frontmatter_content = lines[1..end].join("\n");
        let body_content = lines[(end + 1)..].join("\n");

        // Parse YAML
        match serde_yaml::from_str::<CommandFrontmatter>(&frontmatter_content) {
            Ok(frontmatter) => Ok((Some(frontmatter), body_content)),
            Err(e) => {
                debug!("Failed to parse frontmatter: {}", e);
                // Return full content if frontmatter parsing fails
                Ok((None, content.to_string()))
            }
        }
    } else {
        // Malformed frontmatter, treat as regular content
        Ok((None, content.to_string()))
    }
}

/// Extract command name and namespace from file path
fn extract_command_info(file_path: &Path, base_path: &Path) -> Result<(String, Option<String>)> {
    let relative_path = file_path
        .strip_prefix(base_path)
        .context("Failed to get relative path")?;

    // Remove .md extension
    let path_without_ext = relative_path
        .with_extension("")
        .to_string_lossy()
        .to_string();

    // Split into components
    let components: Vec<&str> = path_without_ext.split('/').collect();

    if components.is_empty() {
        return Err(anyhow::anyhow!("Invalid command path"));
    }

    if components.len() == 1 {
        // No namespace
        Ok((components[0].to_string(), None))
    } else {
        // Last component is the command name, rest is namespace
        let command_name = components.last().unwrap().to_string();
        let namespace = components[..components.len() - 1].join(":");
        Ok((command_name, Some(namespace)))
    }
}

/// Load a single command from a markdown file
fn load_command_from_file(file_path: &Path, base_path: &Path, scope: &str) -> Result<SlashCommand> {
    debug!("Loading command from: {:?}", file_path);

    // Read file content
    let content = fs::read_to_string(file_path).context("Failed to read command file")?;

    // Parse frontmatter
    let (frontmatter, body) = parse_markdown_with_frontmatter(&content)?;

    // Extract command info
    let (name, namespace) = extract_command_info(file_path, base_path)?;

    // Build full command (no scope prefix, just /command or /namespace:command)
    let full_command = match &namespace {
        Some(ns) => format!("/{ns}:{name}"),
        None => format!("/{name}"),
    };

    // Generate unique ID
    let id = format!(
        "{}-{}",
        scope,
        file_path.to_string_lossy().replace('/', "-")
    );

    // Check for special content
    let has_bash_commands = body.contains("!`");
    let has_file_references = body.contains('@');
    let accepts_arguments = body.contains("$ARGUMENTS");

    // Extract metadata from frontmatter
    let (description, allowed_tools) = if let Some(fm) = frontmatter {
        (fm.description, fm.allowed_tools.unwrap_or_default())
    } else {
        (None, Vec::new())
    };

    Ok(SlashCommand {
        id,
        name,
        full_command,
        scope: scope.to_string(),
        namespace,
        file_path: file_path.to_string_lossy().to_string(),
        content: body,
        description,
        allowed_tools,
        has_bash_commands,
        has_file_references,
        accepts_arguments,
    })
}

/// Recursively find all markdown files in a directory
fn find_markdown_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        // Skip hidden files/directories
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }

        if path.is_dir() {
            find_markdown_files(&path, files)?;
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext == "md" {
                    files.push(path);
                }
            }
        }
    }

    Ok(())
}

/// Create default/built-in slash commands
fn create_default_commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand {
            id: "default-add-dir".to_string(),
            name: "add-dir".to_string(),
            full_command: "/add-dir".to_string(),
            scope: "default".to_string(),
            namespace: None,
            file_path: "".to_string(),
            content: "Add additional working directories".to_string(),
            description: Some("Add additional working directories".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: false,
        },
        SlashCommand {
            id: "default-init".to_string(),
            name: "init".to_string(),
            full_command: "/init".to_string(),
            scope: "default".to_string(),
            namespace: None,
            file_path: "".to_string(),
            content: "Initialize project with CLAUDE.md guide".to_string(),
            description: Some("Initialize project with CLAUDE.md guide".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: false,
        },
        SlashCommand {
            id: "default-review".to_string(),
            name: "review".to_string(),
            full_command: "/review".to_string(),
            scope: "default".to_string(),
            namespace: None,
            file_path: "".to_string(),
            content: "Request code review".to_string(),
            description: Some("Request code review".to_string()),
            allowed_tools: vec![],
            has_bash_commands: false,
            has_file_references: false,
            accepts_arguments: false,
        },
    ]
}

/// Find the latest version directory for each plugin under plugins/cache.
/// Structure: plugins/cache/<marketplace>/<plugin>/<version>/
/// Returns a list of the highest-version directories per plugin.
fn find_latest_plugin_dirs(plugins_cache: &Path) -> Vec<PathBuf> {
    let mut latest: std::collections::HashMap<String, (PathBuf, String)> =
        std::collections::HashMap::new();

    let Ok(marketplaces) = fs::read_dir(plugins_cache) else {
        return Vec::new();
    };
    for mp_entry in marketplaces.flatten() {
        let mp_path = mp_entry.path();
        if !mp_path.is_dir() {
            continue;
        }
        let Ok(plugins) = fs::read_dir(&mp_path) else {
            continue;
        };
        for plugin_entry in plugins.flatten() {
            let plugin_path = plugin_entry.path();
            if !plugin_path.is_dir() {
                continue;
            }
            let plugin_key = format!(
                "{}:{}",
                mp_path.file_name().unwrap_or_default().to_string_lossy(),
                plugin_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            );
            let Ok(versions) = fs::read_dir(&plugin_path) else {
                continue;
            };
            for ver_entry in versions.flatten() {
                let ver_path = ver_entry.path();
                if !ver_path.is_dir() {
                    continue;
                }
                let ver_name = ver_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                // Keep the lexicographically highest version (works for semver)
                if let Some(existing) = latest.get(&plugin_key) {
                    if ver_name > existing.1 {
                        latest.insert(plugin_key.clone(), (ver_path, ver_name));
                    }
                } else {
                    latest.insert(plugin_key.clone(), (ver_path, ver_name));
                }
            }
        }
    }
    latest.into_values().map(|(path, _)| path).collect()
}

/// Load a skill from a SKILL.md file
fn load_skill_from_file(
    skill_dir: &Path,
    plugin_name: Option<&str>,
    scope: &str,
) -> Result<SlashCommand> {
    let skill_file = skill_dir.join("SKILL.md");
    if !skill_file.exists() {
        return Err(anyhow::anyhow!("No SKILL.md in {:?}", skill_dir));
    }
    let content = fs::read_to_string(&skill_file).context("Failed to read skill file")?;
    let (frontmatter, body) = parse_markdown_with_frontmatter(&content)?;

    let dir_name = skill_dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let (name, full_command) = if let Some(pname) = plugin_name {
        (dir_name.clone(), format!("/{pname}:{dir_name}"))
    } else {
        (dir_name.clone(), format!("/{dir_name}"))
    };

    let id = format!(
        "{}-skill-{}",
        scope,
        skill_file.to_string_lossy().replace('/', "-")
    );

    let (description, allowed_tools) = if let Some(fm) = frontmatter {
        (fm.description, fm.allowed_tools.unwrap_or_default())
    } else {
        (None, Vec::new())
    };

    let has_bash_commands = body.contains("!`");
    let has_file_references = body.contains('@');
    let accepts_arguments = body.contains("$ARGUMENTS");

    Ok(SlashCommand {
        id,
        name,
        full_command,
        scope: scope.to_string(),
        namespace: plugin_name.map(|s| s.to_string()),
        file_path: skill_file.to_string_lossy().to_string(),
        content: body,
        description,
        allowed_tools,
        has_bash_commands,
        has_file_references,
        accepts_arguments,
    })
}

/// Discover all custom slash commands
/// Internal helper for listing slash commands (callable from other functions)
fn list_commands_inner(
    account_dir: Option<PathBuf>,
    project_path: Option<&str>,
) -> Result<Vec<SlashCommand>, String> {
    info!("Discovering slash commands");
    let mut commands = Vec::new();

    // Add default commands
    commands.extend(create_default_commands());

    // Load project commands if project path is provided
    if let Some(proj_path) = project_path {
        let project_commands_dir = PathBuf::from(&proj_path).join(".claude").join("commands");
        if project_commands_dir.exists() {
            debug!("Scanning project commands at: {:?}", project_commands_dir);

            let mut md_files = Vec::new();
            if let Err(e) = find_markdown_files(&project_commands_dir, &mut md_files) {
                error!("Failed to find project command files: {}", e);
            } else {
                for file_path in md_files {
                    match load_command_from_file(&file_path, &project_commands_dir, "project") {
                        Ok(cmd) => {
                            debug!("Loaded project command: {}", cmd.full_command);
                            commands.push(cmd);
                        }
                        Err(e) => {
                            error!("Failed to load command from {:?}: {}", file_path, e);
                        }
                    }
                }
            }
        }

        // Load project skills from .claude/skills/
        let project_skills_dir = PathBuf::from(&proj_path).join(".claude").join("skills");
        if project_skills_dir.exists() {
            debug!("Scanning project skills at: {:?}", project_skills_dir);
            if let Ok(entries) = fs::read_dir(&project_skills_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        match load_skill_from_file(&path, None, "project") {
                            Ok(cmd) => {
                                debug!("Loaded project skill: {}", cmd.full_command);
                                commands.push(cmd);
                            }
                            Err(e) => {
                                debug!("Skipping skill dir {:?}: {}", path, e);
                            }
                        }
                    }
                }
            }
        }
    }

    // Load user commands from account config dir
    if let Some(ref acct_dir) = account_dir {
        let user_commands_dir = acct_dir.join("commands");
        if user_commands_dir.exists() {
            debug!("Scanning user commands at: {:?}", user_commands_dir);

            let mut md_files = Vec::new();
            if let Err(e) = find_markdown_files(&user_commands_dir, &mut md_files) {
                error!("Failed to find user command files: {}", e);
            } else {
                for file_path in md_files {
                    match load_command_from_file(&file_path, &user_commands_dir, "user") {
                        Ok(cmd) => {
                            debug!("Loaded user command: {}", cmd.full_command);
                            commands.push(cmd);
                        }
                        Err(e) => {
                            error!("Failed to load command from {:?}: {}", file_path, e);
                        }
                    }
                }
            }
        }
    }

    // Load plugin commands and skills from account config dir
    if let Some(ref acct_dir) = account_dir {
        let plugins_cache = acct_dir.join("plugins").join("cache");
        if plugins_cache.exists() {
            debug!("Scanning plugin commands/skills at: {:?}", plugins_cache);
            let plugin_dirs = find_latest_plugin_dirs(&plugins_cache);

            for plugin_dir in &plugin_dirs {
                let plugin_name = plugin_dir
                    .parent()
                    .and_then(|p| p.file_name())
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                // Plugin commands
                let cmds_dir = plugin_dir.join("commands");
                if cmds_dir.exists() {
                    let mut md_files = Vec::new();
                    if let Err(e) = find_markdown_files(&cmds_dir, &mut md_files) {
                        error!(
                            "Failed to find plugin command files in {:?}: {}",
                            cmds_dir, e
                        );
                    } else {
                        for file_path in md_files {
                            match load_command_from_file(&file_path, &cmds_dir, "plugin") {
                                Ok(mut cmd) => {
                                    // Prefix with plugin name for namespacing
                                    if cmd.namespace.is_none() {
                                        cmd.namespace = Some(plugin_name.clone());
                                        cmd.full_command = format!("/{}:{}", plugin_name, cmd.name);
                                    }
                                    debug!("Loaded plugin command: {}", cmd.full_command);
                                    commands.push(cmd);
                                }
                                Err(e) => {
                                    debug!(
                                        "Failed to load plugin command from {:?}: {}",
                                        file_path, e
                                    );
                                }
                            }
                        }
                    }
                }

                // Plugin skills
                let skills_dir = plugin_dir.join("skills");
                if skills_dir.exists() {
                    if let Ok(entries) = fs::read_dir(&skills_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.is_dir() {
                                match load_skill_from_file(&path, Some(&plugin_name), "plugin") {
                                    Ok(cmd) => {
                                        debug!("Loaded plugin skill: {}", cmd.full_command);
                                        commands.push(cmd);
                                    }
                                    Err(e) => {
                                        debug!("Skipping plugin skill {:?}: {}", path, e);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    info!("Found {} slash commands", commands.len());
    Ok(commands)
}

/// Discover all custom slash commands (Tauri command wrapper)
#[tauri::command]
pub async fn slash_commands_list(
    account_state: tauri::State<'_, crate::accounts::AccountManagerState>,
    project_path: Option<String>,
) -> Result<Vec<SlashCommand>, String> {
    let account_dir = crate::commands::claude::get_default_account_dir(&account_state).ok();
    list_commands_inner(account_dir, project_path.as_deref())
}

/// Get a single slash command by ID
#[tauri::command]
pub async fn slash_command_get(
    account_state: tauri::State<'_, crate::accounts::AccountManagerState>,
    command_id: String,
) -> Result<SlashCommand, String> {
    debug!("Getting slash command: {}", command_id);

    let parts: Vec<&str> = command_id.split('-').collect();
    if parts.len() < 2 {
        return Err("Invalid command ID".to_string());
    }

    let account_dir = crate::commands::claude::get_default_account_dir(&account_state).ok();
    let commands = list_commands_inner(account_dir, None)?;

    commands
        .into_iter()
        .find(|cmd| cmd.id == command_id)
        .ok_or_else(|| format!("Command not found: {}", command_id))
}

/// Create or update a slash command
#[tauri::command]
pub async fn slash_command_save(
    account_state: tauri::State<'_, crate::accounts::AccountManagerState>,
    scope: String,
    name: String,
    namespace: Option<String>,
    content: String,
    description: Option<String>,
    allowed_tools: Vec<String>,
    project_path: Option<String>,
) -> Result<SlashCommand, String> {
    info!("Saving slash command: {} in scope: {}", name, scope);

    // Validate inputs
    if name.is_empty() {
        return Err("Command name cannot be empty".to_string());
    }

    if !["project", "user"].contains(&scope.as_str()) {
        return Err("Invalid scope. Must be 'project' or 'user'".to_string());
    }

    // Determine base directory
    let base_dir = if scope == "project" {
        if let Some(proj_path) = project_path {
            PathBuf::from(proj_path).join(".claude").join("commands")
        } else {
            return Err("Project path required for project scope".to_string());
        }
    } else {
        crate::commands::claude::get_default_account_dir(&account_state)?.join("commands")
    };

    // Build file path
    let mut file_path = base_dir.clone();
    if let Some(ns) = &namespace {
        for component in ns.split(':') {
            file_path = file_path.join(component);
        }
    }

    // Create directories if needed
    fs::create_dir_all(&file_path).map_err(|e| format!("Failed to create directories: {}", e))?;

    // Add filename
    file_path = file_path.join(format!("{}.md", name));

    // Build content with frontmatter
    let mut full_content = String::new();

    // Add frontmatter if we have metadata
    if description.is_some() || !allowed_tools.is_empty() {
        full_content.push_str("---\n");

        if let Some(desc) = &description {
            full_content.push_str(&format!("description: {}\n", desc));
        }

        if !allowed_tools.is_empty() {
            full_content.push_str("allowed-tools:\n");
            for tool in &allowed_tools {
                full_content.push_str(&format!("  - {}\n", tool));
            }
        }

        full_content.push_str("---\n\n");
    }

    full_content.push_str(&content);

    // Write file
    fs::write(&file_path, &full_content)
        .map_err(|e| format!("Failed to write command file: {}", e))?;

    // Load and return the saved command
    load_command_from_file(&file_path, &base_dir, &scope)
        .map_err(|e| format!("Failed to load saved command: {}", e))
}

/// Delete a slash command
#[tauri::command]
pub async fn slash_command_delete(
    account_state: tauri::State<'_, crate::accounts::AccountManagerState>,
    command_id: String,
    project_path: Option<String>,
) -> Result<String, String> {
    info!("Deleting slash command: {}", command_id);

    // First, we need to determine if this is a project command by parsing the ID
    let is_project_command = command_id.starts_with("project-");

    // If it's a project command and we don't have a project path, error out
    if is_project_command && project_path.is_none() {
        return Err("Project path required to delete project commands".to_string());
    }

    // List all commands (including project commands if applicable)
    let account_dir = crate::commands::claude::get_default_account_dir(&account_state).ok();
    let commands = list_commands_inner(account_dir, project_path.as_deref())?;

    // Find the command by ID
    let command = commands
        .into_iter()
        .find(|cmd| cmd.id == command_id)
        .ok_or_else(|| format!("Command not found: {}", command_id))?;

    // Delete the file
    fs::remove_file(&command.file_path)
        .map_err(|e| format!("Failed to delete command file: {}", e))?;

    // Clean up empty directories
    if let Some(parent) = Path::new(&command.file_path).parent() {
        let _ = remove_empty_dirs(parent);
    }

    Ok(format!("Deleted command: {}", command.full_command))
}

/// Remove empty directories recursively
fn remove_empty_dirs(dir: &Path) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    // Check if directory is empty
    let is_empty = fs::read_dir(dir)?.next().is_none();

    if is_empty {
        fs::remove_dir(dir)?;

        // Try to remove parent if it's also empty
        if let Some(parent) = dir.parent() {
            let _ = remove_empty_dirs(parent);
        }
    }

    Ok(())
}
