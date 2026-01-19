# Agent Hub Development Guide

## Overview

Agent Hub is a Tauri desktop application for managing AI coding agent sessions. It supports multiple interfaces:
- **Desktop App** - Native macOS application with terminal and chat UI
- **Mobile Web** - Browser-based interface accessible from mobile devices
- **iOS App** - Native iOS app (in development)

## Prerequisites

- Node.js 20+
- Rust (latest stable)
- npm or bun
- Xcode (for iOS builds)

## Development Setup

```bash
# Install dependencies
npm install

# Start development server
npm run tauri dev
```

The dev server runs at:
- Frontend: http://localhost:1420
- Mobile Web: http://localhost:3857

## Building Releases

### Version Bumping

All version files must stay in sync:
- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

Use the release script to bump versions:

```bash
# Bump patch version (0.1.2 -> 0.1.3)
npm run release patch

# Bump minor version (0.1.2 -> 0.2.0)
npm run release minor

# Set specific version
npm run release 1.0.0
```

The script will:
1. Update all version files
2. Commit the changes
3. Create a release branch
4. Push to origin

### Manual Release Build

```bash
# Build release
npm run tauri build

# Output locations:
# - App: src-tauri/target/release/bundle/macos/Agent Hub.app
# - DMG: src-tauri/target/release/bundle/dmg/Agent Hub_X.Y.Z_aarch64.dmg
```

### Installing Release

```bash
# Copy to Applications
ditto "src-tauri/target/release/bundle/macos/Agent Hub.app" /Applications/"Agent Hub.app"
```

## Testing

### Desktop App Testing

1. Start dev server: `npm run tauri dev`
2. The desktop app window opens automatically
3. Test features in the native window

You can also use the MCP tools for automated testing:
- The app exposes an MCP server via `mcp-bridge.cjs`
- Tools available: `take_screenshot`, `execute_js`, `get_ui_state`, `click_element`, `type_text`, etc.

### Mobile Web Testing

1. Start dev server: `npm run tauri dev`
2. Access http://localhost:3857 from a mobile browser or use:

```bash
# Using agent-browser skill (if configured)
agent-browser open http://localhost:3857
agent-browser snapshot -i
```

Mobile web features:
- Pair with desktop app using QR code
- View and interact with sessions
- Create new sessions (Claude, Claude (xterm), Aider, Shell)
- Chat interface for JSON sessions

### iOS App Testing

For iOS simulator testing, consider using [ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp):

```bash
# Install
npm install -g ios-simulator-mcp

# Use with Claude Code to automate iOS testing
```

iOS build (requires Xcode):
```bash
npm run tauri ios build
```

## Architecture

### Session Types

| Type | Interface | Command |
|------|-----------|---------|
| `claude-json` | Chat UI | `claude --print --input-format stream-json --output-format stream-json --verbose` |
| `claude` | Terminal (xterm) | `claude --dangerously-skip-permissions` |
| `aider` | Terminal | `aider` |
| `shell` | Terminal | `$SHELL` |
| `custom` | Terminal | User-defined |

### Key Files

- `src/main.ts` - Frontend TypeScript (UI, session management)
- `src/styles.css` - Styling
- `src-tauri/src/lib.rs` - Rust backend (PTY, JSON process, web server)
- `src-tauri/src/mcp.rs` - MCP server implementation
- `index.html` - Main HTML structure

### JSON Session Data

The JSON streaming mode provides rich session data:

```json
// Init message
{
  "type": "system",
  "subtype": "init",
  "model": "claude-opus-4-5-20251101",
  "session_id": "uuid",
  "permissionMode": "bypassPermissions",
  "claude_code_version": "2.1.12",
  "cwd": "/path/to/project"
}

// Assistant message with token usage
{
  "type": "assistant",
  "message": {
    "content": [...],
    "usage": {
      "input_tokens": 3,
      "cache_read_input_tokens": 14015,
      "cache_creation_input_tokens": 5953,
      "output_tokens": 10
    }
  }
}

// Result message with totals
{
  "type": "result",
  "duration_ms": 2810,
  "total_cost_usd": 0.044,
  "num_turns": 1
}
```

### PTY Session ID Detection

For terminal (xterm) Claude sessions, the app automatically detects Claude's session ID by:
1. Starting Claude without `--session-id`
2. Scanning `~/.claude/projects/[project-path]/` for new `.jsonl` files
3. Extracting the session ID from the newest file
4. Storing it for `--resume` on subsequent starts

**Known limitation:** If you use `/resume` within an existing xterm session to switch to a different Claude session, Agent Hub will not detect the new session ID. The stored ID only updates when the PTY session is first spawned. JSON sessions don't have this limitation—they update the session ID from each `init` message.

## Troubleshooting

### "No such file or directory" when spawning Claude

The release build needs to source shell profiles to find `claude` in PATH. The app uses `-i -l -c` flags to start an interactive login shell.

### Session not resuming

Check that `claudeSessionId` is being detected and saved. For JSON sessions, this comes from the `init` message. For terminal sessions, it's detected by scanning the projects folder.

### Mobile web not connecting

1. Ensure desktop app is running
2. Check that port 3857 is accessible
3. Pair devices if prompted

## Contributing

1. Make changes
2. Test with `npm run tauri dev`
3. Run type check: `npm run build` (frontend only)
4. Create PR with description of changes
