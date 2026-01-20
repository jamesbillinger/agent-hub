#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.join(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');

// Parse args
const args = process.argv.slice(2);
const noInstall = args.includes('--no-install') || args.includes('--build-only');

// Read current version
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const currentVersion = packageJson.version;

// Bump patch version
const [major, minor, patch] = currentVersion.split('.').map(Number);
const newVersion = `${major}.${minor}.${patch + 1}`;

console.log(`\n🚀 Agent Hub Release`);
console.log(`   ${currentVersion} → ${newVersion}\n`);

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`✓ Updated package.json`);

// Update tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = newVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
console.log(`✓ Updated tauri.conf.json`);

// Update Cargo.toml
let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
cargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${newVersion}"`);
fs.writeFileSync(cargoTomlPath, cargoToml);
console.log(`✓ Updated Cargo.toml`);

// Build
console.log(`\n📦 Building release...\n`);
try {
  execSync('npm run tauri build', { cwd: rootDir, stdio: 'inherit' });
} catch (e) {
  console.error('\n❌ Build failed');
  process.exit(1);
}

const appSource = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Agent Hub.app');
const appDest = '/Applications/Agent Hub.app';

if (noInstall) {
  console.log(`\n✅ Release ${newVersion} built (--no-install)!\n`);
  console.log(`   App bundle: ${appSource}`);
  console.log(`   DMG: src-tauri/target/release/bundle/dmg/`);
  console.log(`\n   To install manually:`);
  console.log(`   ditto "${appSource}" "${appDest}"\n`);
} else {
  // Install to Applications
  console.log(`\n📲 Installing to Applications...`);

  // Kill running app
  try {
    execSync('pkill -f "Agent Hub"', { stdio: 'ignore' });
    execSync('sleep 1');
  } catch (e) {
    // App might not be running, that's fine
  }

  // Remove old and copy new
  try {
    execSync(`rm -rf "${appDest}"`);
    execSync(`ditto "${appSource}" "${appDest}"`);
    console.log(`✓ Installed to ${appDest}`);
  } catch (e) {
    console.error(`\n❌ Failed to install. You can manually run:`);
    console.error(`   ditto "${appSource}" "${appDest}"`);
    process.exit(1);
  }

  console.log(`\n✅ Release ${newVersion} complete!\n`);
  console.log(`   App installed to: ${appDest}`);
  console.log(`   DMG available at: src-tauri/target/release/bundle/dmg/\n`);
}
