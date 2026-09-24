# Agent Hub - Claude Instructions

## Releasing a New Version

The release workflow triggers on tag pushes matching `v*` (e.g., `v0.1.45`).

### Release Steps:
1. Bump version in `src-tauri/Cargo.toml`
2. Commit and push to main
3. Create and push a tag: `git tag v0.1.45 && git push origin v0.1.45`

That's it! The GitHub Actions workflow will build, sign, notarize, and create the release.

## Project Structure

- `src-tauri/` - Rust backend (Tauri app)
- `src/` - Frontend TypeScript/HTML (desktop UI)
- `mobile-web/` - React app for mobile web interface (Vite + TypeScript + Tailwind)
- `mobile/` - Expo React Native app (native iOS/Android)
- `.github/workflows/release.yml` - Release workflow (triggers on `v*` tags)

## Web Server Ports

The Rust backend runs a web server for mobile web access:

- **Dev** (`cargo tauri dev`): Port **3857** (with fallback to 3858-3866 if busy)
- **Prod** (release build): Port **3847** (fixed, no fallback)

This allows running both dev and prod apps simultaneously without port conflicts.

## Mobile Web

The mobile web interface is a separate React app in `mobile-web/`. It connects to the desktop app's web server.

### Testing Mobile Web (Dev)

1. Start the dev app: `cargo tauri dev` (runs on port 3857)
2. The mobile-web dev server runs on port 5173 but isn't needed for testing
3. Open `http://localhost:3857` in a browser (or use the `agent-browser` skill)
4. You'll see a pairing screen - get the pairing code from the desktop app's console output
5. Enter the pairing code to authenticate

### Testing with agent-browser skill

Use the `agent-browser` skill to automate mobile web testing:
```
/agent-browser
Navigate to http://localhost:3857
```

The pairing code appears in the desktop app's terminal output when requested.

### Mobile Web Architecture

- `mobile-web/src/App.tsx` - Main app component, handles routing between session list and chat
- `mobile-web/src/stores/` - Zustand stores for state management
  - `authStore.ts` - Authentication state (persisted to localStorage as `agent-hub-auth`)
  - `sessionsStore.ts` - Session list and active session
- `mobile-web/src/components/` - React components

### Authentication Flow

1. Mobile web requests a pairing code via `/api/auth/request-pairing`
2. Desktop app shows the 6-digit code in its UI/logs
3. User enters code on mobile, which calls `/api/auth/pair`
4. On success, mobile receives an auth token stored in localStorage
5. Subsequent requests include the token in the Authorization header

## MCP Integration

The `agent-hub` MCP server allows Claude Code to interact with the Agent Hub app.

### Which App is MCP Connected To?

**The MCP always connects to the DEV app (port 3857)**, not prod.

This is configured in `.mcp.json` which runs `mcp-bridge.cjs`. The bridge connects to `AGENT_HUB_PORT` which defaults to 3857.

To verify which app you're connected to:
```bash
# Check what's on port 3857 (dev)
curl -s http://localhost:3857/api/auth/check

# Check what's on port 3847 (prod)
curl -s http://localhost:3847/api/auth/check
```

**IMPORTANT:** Don't rely on the window title to determine which app you're connected to. In single-session view it is "<session name> · <subtitle> — Agent Hub" (or "… — Agent Hub (Dev)"), and in grid view or with no session just the app name. Use the port check above instead.

### MCP Tools

- `take_screenshot` - Capture the current app state (title, URL, body text)
- `execute_js` - Run JavaScript in the webview. The code is evaluated as an
  expression, so wrap multi-statement code in an IIFE: `(() => { ...; return x; })()`
- `click_element`, `type_text` - Interact with UI elements
- `list_elements` - List all interactive elements with selectors
- `get_ui_state` - Get detailed UI state including buttons, inputs, links
- `select_window` - Point the tools above at a window: `main` (default) or a
  pop-out session window's `session-<session id>`

Without the bridge, the same thing over HTTP (the local token lives in
`~/Library/Application Support/agent-hub-dev/local-token`):
```bash
curl -s http://localhost:3857/api/mcp/execute -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"window":"session-<id>","code":"document.title"}'
```
A request naming a window that isn't open gets a 404 listing the open labels.

### Testing Dev App via MCP

1. Make sure dev app is running: `npm run tauri dev`
2. Verify it's on port 3857: `lsof -i :3857`
3. Use MCP tools - they will interact with the dev app

## Pop-out Session Windows

A chat session can be opened in its own window (footer `⧉` button, or
"Open in New Window" in the session's context menu) so it can sit on another
monitor. Pop-outs are Tauri windows labelled `session-<session id>` that load
the same frontend; `src/main.ts` reads the window label at startup and, in a
pop-out, hides the sidebar and shows just that session.

- The Rust side is shared, and process events are broadcast to every window,
  so a pop-out only renders. The main window stays the owner of one-time side
  effects: notifications, persisting lifecycle notices, MCP and pairing.
- A message typed in one window is echoed to the others via the
  `hub-local-message` event and persisted where it was typed.
- Tauri JS listeners receive *targeted* emits too, so events meant for one
  window (`menu-event`, `mcp-execute`) carry a `window` label in the payload
  and the frontend filters on it.
- Pop-out geometry is stored under `popouts` in `window_state.json` (owned by
  Rust; the main window's save never overwrites it) and reopened on launch.
  Closing a pop-out forgets it; quitting keeps it.

## Session Subtitles (Haiku)

After each completed turn of a chat session the backend may write a one-line
subtitle ("Auctria Stripe setup") into `sessions.ai_title`, shown under the
name in the desktop sidebar, in a pop-out's window title, and on the mobile
session card. See `maybe_generate_session_title` in `src-tauri/src/lib.rs`.

- It runs `claude -p --model claude-haiku-4-5 --no-session-persistence
  --tools ""` with the last few readable exchanges on stdin, so it uses the
  same login as every other session and leaves no transcript file. Do not add
  `--bare`: that mode ignores keychain/OAuth auth and fails with "Not logged in".
- Throttled per session: first title after the first turn, then only after 3
  more user turns and at least 3 minutes. Off via the "Summarize sessions with
  Haiku" checkbox in Settings (`ai_titles_enabled`).
- Claude Code writes its own `ai-title` records only for interactive
  sessions; a session started with `-n <name>` gets a `custom-title` record
  instead, which is why the app generates its own.

## Remote Access & Teams Webhook

`agent.billinger.me` and the Power Automate → Teams issue pipeline share one
network path: DNS → FortiGate → haproxy on `10.30.90.202` → this Mac at
`10.30.90.201:3847`. **If both break at once, it's the shared path, not two
bugs** — most likely this Mac lost its `.201` DHCP reservation because macOS
Private Wi-Fi Address randomized the MAC the reservation is keyed to.

See [REMOTE_ACCESS.md](REMOTE_ACCESS.md) for the full topology, the FortiGate
reservations, an ordered diagnostic script, and the webhook auth gotcha (the
shipped handler skips auth entirely when the secret env var is unset).

## Debugging

### Performance Debugging

Set these in the browser console:
- `window.PERF_DEBUG = true` - Log render performance metrics
- `window.INPUT_DEBUG = true` - Log input event timing
- `window.KEY_DEBUG = true` - Log keyboard event timing

### Common Issues

- **Settings shows "Loading..." for Web Interface URL**: The web server starts asynchronously. The frontend retries a few times to handle the race condition.
- **Mobile web back button doesn't work**: Check that the URL hash is being cleared when navigating back. The session restore effect should only run on mount, not on every activeSessionId change.
