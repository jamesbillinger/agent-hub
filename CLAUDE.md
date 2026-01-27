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
- `src/` - Frontend TypeScript/HTML
- `mobile/` - Expo React Native app
- `.github/workflows/release.yml` - Release workflow (triggers on `v*` tags)

## Mobile Web

The mobile web interface is embedded in `src-tauri/src/lib.rs` as inline HTML/CSS/JS. Changes to mobile web require modifying the Rust file directly.
