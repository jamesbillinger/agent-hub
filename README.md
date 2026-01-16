# Agent Hub

A desktop application for managing AI coding agent sessions (Claude Code, Aider, etc.) with persistent sessions that survive app restarts.

## Problem Statement

When using Claude Code or other AI coding agents in iTerm2, sessions are lost when the terminal closes or the machine restarts. This app provides:

- **Persistent sessions** - Sessions survive app quit and machine restart
- **Session resume** - Claude Code sessions resume where you left off using `--resume`
- **Terminal scrollback** - Full terminal history is preserved
- **Session organization** - Search, sort, and drag-to-reorder sessions
- **Multi-agent support** - Claude Code, Aider, shell, or custom commands

## Architecture

**Stack:** Tauri 2.x (Rust backend) + xterm.js (terminal emulator) + SQLite (persistence)

### Why This Stack?

We evaluated two approaches:

#### Attempt 1: SwiftUI + SwiftTerm (Failed)

Initially tried native macOS with SwiftUI and [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm):

**Issues encountered:**
- Cursor positioning broken with Claude Code's TUI
- Text copy functionality broken
- Shift+Enter didn't work (critical for multi-line input)
- GitHub issue [#441](https://github.com/migueldeicaza/SwiftTerm/issues/441) confirms SwiftTerm has issues with Claude Code

**Conclusion:** SwiftTerm isn't mature enough for complex TUI applications like Claude Code.

#### Attempt 2: Tauri + xterm.js (Success)

Switched to Tauri with xterm.js:

**Why it works:**
- xterm.js is battle-tested (used by VS Code, Hyper, etc.)
- Full terminal fidelity - colors, cursor positioning, TUI rendering
- Shift+Enter works correctly
- Image paste works
- All keyboard shortcuts work (Ctrl+C, Ctrl+O, etc.)

**Trade-offs:**
- Larger bundle size than pure native
- Web-based rendering (but xterm.js is highly optimized)

## Features

### Session Management
- Create sessions with different agent types (Claude Code, Aider, shell, custom)
- Sessions persist to SQLite database
- Quick create with `+ New` button or `Cmd+T`
- Rename sessions with double-click or `Cmd+I`
- Close sessions with `Cmd+W`

### Claude Code Integration
- Automatically uses `--dangerously-skip-permissions` mode
- Pre-generates session IDs for each Claude session
- First run uses `--session-id <uuid>`
- Subsequent runs use `--resume <uuid>` to continue conversation
- Works across app restarts

### Terminal Persistence
- Full scrollback buffer saved (up to 10,000 lines)
- Compressed with gzip for efficient storage
- Auto-saves every 30 seconds
- Saves on process exit
- Restores on session reopen with "[Session restored]" indicator

### Session Organization
- **Search** - Filter by session name, agent type, or working directory
- **Sort** - Custom order, name, date created, or agent type
- **Drag-and-drop** - Reorder sessions when sort is "Custom Order"

### Native macOS Experience
- Full menu bar (File, Edit, View, Session, Window, Help)
- Keyboard shortcuts:
  - `Cmd+T` - New session
  - `Cmd+W` - Close session
  - `Cmd+I` - Rename session
  - `Cmd+B` - Toggle sidebar
  - `Cmd+,` - Settings
  - `Cmd++/-/0` - Zoom in/out/reset
- Window state persisted (size, position, sidebar width)
- Notifications when processes exit (optional)

### Settings
- Font size and family
- Theme (dark mode)
- Default working directory
- Default agent type
- Notification preferences

## Project Structure

```
agent-hub-tauri/
├── src/
│   ├── main.ts          # Frontend TypeScript - UI, terminal management
│   └── styles.css       # Styling
├── src-tauri/
│   ├── src/
│   │   └── lib.rs       # Rust backend - PTY, database, menus
│   ├── capabilities/
│   │   └── default.json # Tauri permissions
│   └── Cargo.toml       # Rust dependencies
├── index.html           # Main HTML with modals
├── package.json         # Node dependencies
└── README.md
```

## Key Dependencies

### Rust (src-tauri/Cargo.toml)
- `tauri` - Desktop app framework
- `portable-pty` - PTY (pseudo-terminal) management
- `rusqlite` - SQLite database
- `flate2` - Gzip compression for terminal buffers
- `base64` - Encoding for safe text storage
- `tauri-plugin-notification` - macOS notifications

### TypeScript (package.json)
- `@xterm/xterm` - Terminal emulator
- `@xterm/addon-fit` - Auto-resize terminal
- `@xterm/addon-serialize` - Serialize terminal buffer
- `@xterm/addon-web-links` - Clickable URLs

## Development

### Prerequisites
- Node.js 18+
- Rust (via rustup)
- Xcode Command Line Tools (macOS)

### Setup
```bash
cd agent-hub-tauri
npm install
npm run tauri dev
```

### Build
```bash
npm run tauri build
```

## Technical Notes

### Shift+Enter Handling
Claude Code uses Shift+Enter for multi-line input. xterm.js doesn't handle this by default. Solution:

```typescript
terminal.attachCustomKeyEventHandler((event) => {
  if (event.key === "Enter" && event.shiftKey) {
    if (event.type === "keydown") {
      invoke("write_pty", { sessionId: session.id, data: "\n" });
    }
    return false; // Block all Shift+Enter events
  }
  return true;
});
```

### Claude Session Resume
The app tracks whether a Claude session has been started:
- New session: `claude --session-id <uuid> --dangerously-skip-permissions`
- Resume: `claude --resume <uuid> --dangerously-skip-permissions`

The `hasBeenStarted` flag and `claudeSessionId` are persisted in SQLite.

### Terminal Buffer Compression
Terminal buffers can be large (10k lines of text with ANSI codes). We compress with gzip and encode to base64 for SQLite storage:

```rust
// Save: content -> gzip -> base64 -> database
// Load: database -> base64 -> gunzip -> content
```

### WKWebView Terminal Rendering Bug & Workaround

Tauri uses WKWebView on macOS, which has a rendering bug with xterm.js that causes visual artifacts (status lines "burning in", ghost characters, etc.). This affects all renderers (DOM, Canvas, WebGL) - it's not specific to WebGL.

#### The Problem
When terminal escape sequences target positions at or near the exact terminal width, WKWebView's rendering pipeline doesn't properly clear previous frame content. This causes:
- Status lines appearing multiple times on screen
- Ghost characters persisting where they shouldn't
- Box-drawing characters leaving trails

**Key discovery:** The same xterm.js code works perfectly in Safari browser - the bug is specific to WKWebView.

#### Testing Observations
We tested by connecting a mobile client (via Safari) to control sessions while watching the desktop app:
- **Mobile terminal NARROWER than desktop**: Desktop renders perfectly
- **Mobile terminal WIDER than desktop**: Desktop shows severe artifacts
- **Desktop alone (sizes match)**: Artifacts appear

This confirmed the issue is triggered when escape sequences target the exact terminal width.

#### Our Workaround
We tell the PTY it's 2 columns narrower than the actual terminal, creating a buffer zone:

```typescript
function getPtyDimensions(terminalCols: number, terminalRows: number) {
  return {
    cols: Math.max(40, terminalCols - 2),  // 2 column buffer
    rows: terminalRows,
  };
}
```

This ensures escape sequences never target the exact terminal edge where WKWebView has issues.

#### Trade-offs
- Claude Code uses 2 fewer columns than available (barely noticeable)
- Minor cosmetic artifacts may occasionally appear on the right edge
- 99% improvement over the original severe artifacts

#### Why VS Code Doesn't Have This Issue
VS Code uses Electron (Chromium-based), not WKWebView. The bug is specific to WebKit's WKWebView implementation, not xterm.js itself.

## Data Storage

All data stored in `~/Library/Application Support/agent-hub/`:
- `sessions.db` - SQLite database (sessions, terminal buffers)
- `config.json` - App settings
- `window_state.json` - Window position/size

## Known Issues

- **Visual artifacts during heavy TUI output** - The WebGL renderer's texture atlas can become corrupted during rapid screen updates (Claude Code "thinking" animations, etc.). We mitigate this with periodic `clearTextureAtlas()` + `refresh()` calls. See "xterm.js WebGL Rendering & Visual Artifacts" section for details. Resizing the window also clears artifacts. As a fallback, users can switch to DOM renderer in settings.

## Future Ideas

- [x] Light theme (implemented - follows system or manual selection)
- [ ] Session tags/folders
- [ ] Session export/import
- [ ] Multiple windows
- [ ] Session templates
- [ ] Keyboard navigation in session list
- [ ] Context menu on session items

## License

MIT
