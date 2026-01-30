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

The desktop app includes an MCP server for Claude Code integration. The `agent-hub` MCP tools allow:
- `take_screenshot` - Capture the current app state
- `execute_js` - Run JavaScript in the webview
- `click_element`, `type_text` - Interact with UI elements

Use MCP to inspect app state when debugging.

## Debugging

### Performance Debugging

Set these in the browser console:
- `window.PERF_DEBUG = true` - Log render performance metrics
- `window.INPUT_DEBUG = true` - Log input event timing
- `window.KEY_DEBUG = true` - Log keyboard event timing

### Common Issues

- **Settings shows "Loading..." for Web Interface URL**: The web server starts asynchronously. The frontend retries a few times to handle the race condition.
- **Mobile web back button doesn't work**: Check that the URL hash is being cleared when navigating back. The session restore effect should only run on mount, not on every activeSessionId change.
