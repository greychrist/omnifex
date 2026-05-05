
<div align="center">
  <img src="src-tauri/icons/icon.png" alt="GreyChrist Logo" width="120" height="120">

  <h1>GreyChrist</h1>
  
  <p>
    <strong>A powerful GUI app and Toolkit for Claude Code</strong>
  </p>
  <p>
    <strong>Create custom agents, manage interactive Claude Code sessions, run secure background agents, and more.</strong>
  </p>
</div>

> [!NOTE]
> This project is not affiliated with, endorsed by, or sponsored by Anthropic. Claude is a trademark of Anthropic, PBC. This is an independent developer project using Claude.
> 
> GreyChrist is a fork of [opcode](https://github.com/getAsterisk/opcode) by Asterisk, licensed under AGPL-3.0.

## Overview

**GreyChrist** is a desktop application that transforms how you interact with Claude Code. Built with Tauri 2, it provides a GUI for managing Claude Code sessions, creating custom agents, tracking usage across multiple accounts, and more.

## Features

### Project & Session Management
- **Visual Project Browser**: Navigate through all your Claude Code projects
- **Session History**: View and resume past coding sessions with full context
- **Smart Search**: Find projects and sessions quickly with built-in search
- **Multi-Account Support**: Bind projects to specific Claude accounts with path-based routing

### CC Agents
- **Custom AI Agents**: Create specialized agents with custom system prompts and behaviors
- **Agent Library**: Build a collection of purpose-built agents for different tasks
- **Background Execution**: Run agents in separate processes for non-blocking operations
- **Execution History**: Track all agent runs with detailed logs and performance metrics

### Usage Analytics Dashboard
- **Cost Tracking**: Monitor your Claude API usage and costs in real-time
- **Token Analytics**: Detailed breakdown by model, project, and time period
- **Multi-Account Aggregation**: Usage tracked per account with account-type cost logic
- **Visual Charts**: Usage trends and patterns across accounts

### MCP Server Management
- **Server Registry**: Manage Model Context Protocol servers from a central UI
- **Easy Configuration**: Add servers via UI or import from existing configs
- **Connection Testing**: Verify server connectivity before use
- **Claude Desktop Import**: Import server configurations from Claude Desktop

### Timeline & Checkpoints
- **Session Versioning**: Create checkpoints at any point in your coding session
- **Visual Timeline**: Navigate through your session history with a branching timeline
- **Instant Restore**: Jump back to any checkpoint with one click
- **Fork Sessions**: Create new branches from existing checkpoints

### CLAUDE.md Management
- **Built-in Editor**: Edit CLAUDE.md files directly within the app
- **Live Preview**: See your markdown rendered in real-time
- **Project Scanner**: Find all CLAUDE.md files in your projects

## Installation

### Prerequisites

- **Claude Code CLI**: Install from [Claude's official site](https://claude.ai/code)

### Build from Source

1. **Clone the Repository**
   ```bash
   git clone https://github.com/greychrist/omnifex.git
   cd omnifex
   ```

2. **Install Frontend Dependencies**
   ```bash
   npm install
   ```

3. **Build the Application**
   
   **For Development (with hot reload)**
   ```bash
   npm run dev          # Start Vite
   npx tauri dev        # Start Tauri (in another terminal)
   ```
   
   **For Production Build**
   ```bash
   npx tauri build
   ```

#### Platform-Specific Dependencies

**Linux (Ubuntu/Debian)**
```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libxdo-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev
```

**macOS**
```bash
xcode-select --install
```

**Windows**
- Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- Install [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite 6
- **Backend**: Rust with Tauri 2
- **UI Framework**: Tailwind CSS v4 + shadcn/ui
- **Database**: SQLite (via rusqlite)

## Project Structure

```
GreyChrist/
├── src/                   # React frontend
│   ├── components/        # UI components
│   ├── lib/               # API client & utilities
│   └── assets/            # Static assets
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── commands/      # Tauri command handlers
│   │   ├── checkpoint/    # Timeline management
│   │   ├── accounts/      # Multi-account management
│   │   └── process/       # Process management
│   └── tests/             # Rust test suite
├── icons/                 # App icons for bundling
└── assets/                # Source design files (PSD, iconsets)
```

## Security

1. **Process Isolation**: Agents run in separate processes
2. **Permission Control**: Configure file and network access per agent
3. **Local Storage**: All data stays on your machine
4. **No Telemetry**: No data collection or tracking
5. **Open Source**: Full transparency through open source code

## License

This project is licensed under the AGPL-3.0 License - see the [LICENSE](LICENSE) file for details.

Originally forked from [opcode](https://github.com/getAsterisk/opcode) by [Asterisk](https://asterisk.so/).

## Acknowledgments

- Originally created by [Asterisk](https://asterisk.so/) as [opcode](https://github.com/getAsterisk/opcode)
- Built with [Tauri](https://tauri.app/)
- [Claude](https://claude.ai) by Anthropic
