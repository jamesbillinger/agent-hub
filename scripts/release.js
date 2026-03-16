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

// Git operations
console.log(`\n📦 Creating release tag...\n`);

try {
  // Commit version bump
  execSync('git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json', { cwd: rootDir, stdio: 'inherit' });
  execSync(`git commit -m "chore: bump version to ${newVersion}"`, { cwd: rootDir, stdio: 'inherit' });
  console.log(`✓ Committed version bump`);

  // Push to main
  execSync('git push origin main', { cwd: rootDir, stdio: 'inherit' });
  console.log(`✓ Pushed to main`);

  // Create and push tag (triggers CI release workflow)
  execSync(`git tag v${newVersion}`, { cwd: rootDir, stdio: 'inherit' });
  execSync(`git push origin v${newVersion}`, { cwd: rootDir, stdio: 'inherit' });
  console.log(`✓ Pushed tag v${newVersion}`);

  console.log(`\n✅ Release ${newVersion} triggered!\n`);
  console.log(`   CI will build, sign, notarize, and publish the release.`);
  console.log(`   Monitor progress: https://github.com/jamesbillinger/agent-hub/actions\n`);
} catch (e) {
  console.error('\n❌ Release failed');
  console.error(e.message);
  process.exit(1);
}
