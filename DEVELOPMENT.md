# Agent Hub Development Guide

## Overview

Agent Hub is a Tauri desktop application for managing AI coding agent sessions. It supports multiple interfaces:
- **Desktop App** - Native macOS application with terminal and chat UI
- **Mobile Web** - Browser-based interface accessible from mobile devices (port 3857)
- **Mobile App (Expo)** - Native iOS/Android app in the `mobile/` directory

## Prerequisites

- Node.js 20+
- Rust (latest stable)
- npm or bun
- For mobile app: Expo CLI (`npm install -g expo-cli`)

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

### Quick Release (Recommended)

```bash
npm run release
```

This single command:
1. Auto-bumps the patch version (e.g., 0.1.5 → 0.1.6)
2. Updates all version files (package.json, tauri.conf.json, Cargo.toml)
3. Builds the release
4. Kills any running Agent Hub instance
5. Installs to `/Applications/Agent Hub.app`

The DMG is also available at `src-tauri/target/release/bundle/dmg/`

### GitHub Actions Release (CI)

To create a release via GitHub Actions:

```bash
# Create a release branch with the version number
git checkout -b release/0.1.29
git push -u origin release/0.1.29
```

The workflow will:
1. Build for Apple Silicon (aarch64)
2. Sign with your Apple Developer certificate
3. Notarize with Apple
4. Create GitHub release with DMG
5. Generate updater artifacts (tar.gz + signature + latest.json)

#### Required GitHub Secrets

Copy these from the pplsi-sidebar repository or generate new ones:

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 certificate |
| `APPLE_SIGNING_IDENTITY` | Certificate name (e.g., "Developer ID Application: Name (TEAMID)") |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key for Tauri updater signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key (optional) |

The Tauri signing keypair is stored at:
- Private: `~/.tauri/agent-hub.key`
- Public: Already configured in `tauri.conf.json`

### Auto-Updates

The app checks for updates from:
```
https://github.com/jamesbillinger/agent-hub/releases/latest/download/latest.json
```

Update behavior:
- **On startup**: Checks for updates 5 seconds after launch. If an update is available, shows a system notification.
- **Manual check**: Go to Settings → About → "Check for Updates" to check and install.
- **Installing**: Click "Download & Install" to download the update, then the app auto-relaunches.

### Manual Build (without version bump)

```bash
# Build only (keeps current version)
npm run tauri build

# Then manually install
ditto "src-tauri/target/release/bundle/macos/Agent Hub.app" /Applications/"Agent Hub.app"
```

### Cleaning Build Artifacts

The `src-tauri/target/` folder can grow large (10-30GB). To clean:

```bash
cd src-tauri && cargo clean
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

### Mobile App (Expo) Development

The mobile app is a standalone Expo React Native app in the `mobile/` directory.

```bash
cd mobile

# Install dependencies
npm install

# Start Expo development server
npm start

# Or run directly in iOS simulator
npm run ios
```

**Key mobile app features:**
- Connect to Agent Hub desktop via IP address or production URL
- PIN authentication for quick reconnection
- View and manage `claude-json` chat sessions
- Create new sessions from mobile
- Real-time sync with desktop via WebSocket

**Mobile app structure:**
- `mobile/app/` - Expo Router screens
- `mobile/components/` - React Native components
- `mobile/services/` - API client and WebSocket manager
- `mobile/stores/` - Zustand state management

For iOS simulator testing with Claude Code, use [ios-simulator-mcp](https://github.com/anthropics/ios-simulator-mcp).

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

**Desktop App:**
- `src/main.ts` - Frontend TypeScript (UI, session management)
- `src/styles.css` - Styling
- `src-tauri/src/lib.rs` - Rust backend (PTY, JSON process, web server, auth)
- `src-tauri/src/mcp.rs` - MCP server implementation
- `index.html` - Main HTML structure

**Mobile App (Expo):**
- `mobile/app/` - Expo Router screens and layouts
- `mobile/components/chat/` - Chat UI components (ChatView, MessageList, ChatInput)
- `mobile/services/api.ts` - REST API client
- `mobile/services/websocket.ts` - WebSocket connection manager
- `mobile/stores/` - Zustand stores (auth, sessions, settings)

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

### Remote Authentication

The backend supports two authentication methods for mobile/remote access:

1. **QR Code Pairing** - Scan a QR code displayed in the desktop app to pair a device
2. **PIN Authentication** - Set a PIN in Settings for quick reconnection (rate-limited)

Authentication flow:
1. Mobile app connects to desktop's IP:3857
2. If PIN is configured, enter PIN to authenticate
3. Otherwise, request pairing and scan QR code from desktop
4. Token is stored for subsequent connections

## Troubleshooting

### "No such file or directory" when spawning Claude

The release build needs to source shell profiles to find `claude` in PATH. The app uses `-i -l -c` flags to start an interactive login shell.

### Session not resuming

Check that `claudeSessionId` is being detected and saved. For JSON sessions, this comes from the `init` message. For terminal sessions, it's detected by scanning the projects folder.

### Mobile web/app not connecting

1. Ensure desktop app is running
2. Check that port 3857 is accessible (try `curl http://localhost:3857/api/auth/check`)
3. Verify the IP address is correct (network may have changed)
4. Pair devices or enter PIN if prompted

### Mobile app shows "Claude is thinking" indefinitely

This usually means the session command is incorrect. For `claude-json` sessions, the command must include JSON streaming flags:
```
claude --print --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions
```

If an existing session has the wrong command, update it in the database or create a new session.

## Contributing

1. Make changes
2. Test with `npm run tauri dev`
3. Run type check: `npm run build` (frontend only)
4. Create PR with description of changes
