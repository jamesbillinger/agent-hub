#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.join(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

// Parse command line arguments
const args = process.argv.slice(2);
const versionArg = args[0];

if (!versionArg) {
  console.log('Usage: npm run release <version>');
  console.log('       npm run release patch|minor|major');
  console.log('');
  console.log('Examples:');
  console.log('  npm run release 1.2.3');
  console.log('  npm run release patch   # 0.1.0 -> 0.1.1');
  console.log('  npm run release minor   # 0.1.0 -> 0.2.0');
  console.log('  npm run release major   # 0.1.0 -> 1.0.0');
  process.exit(1);
}

// Read current versions
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));

const currentVersion = packageJson.version;
console.log(`Current version: ${currentVersion}`);

// Calculate new version
function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number);
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      return type; // Assume it's an explicit version
  }
}

const newVersion = bumpVersion(currentVersion, versionArg);

// Validate version format
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error(`Invalid version format: ${newVersion}`);
  console.error('Version must be in format: X.Y.Z');
  process.exit(1);
}

console.log(`New version: ${newVersion}`);

// Check for uncommitted changes
try {
  const status = execSync('git status --porcelain', { cwd: rootDir, encoding: 'utf8' });
  if (status.trim()) {
    console.error('Error: You have uncommitted changes. Please commit or stash them first.');
    process.exit(1);
  }
} catch (e) {
  console.error('Error checking git status:', e.message);
  process.exit(1);
}

function performRelease() {
  // Update package.json
  packageJson.version = newVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`Updated package.json to ${newVersion}`);

  // Update tauri.conf.json
  tauriConf.version = newVersion;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log(`Updated tauri.conf.json to ${newVersion}`);

  // Git operations
  try {
    // Commit version bump
    execSync(`git add package.json src-tauri/tauri.conf.json`, { cwd: rootDir, stdio: 'inherit' });
    execSync(`git commit -m "chore: bump version to ${newVersion}"`, { cwd: rootDir, stdio: 'inherit' });
    console.log('Committed version bump');

    // Create and push release branch
    const branchName = `release/${newVersion}`;
    execSync(`git checkout -b ${branchName}`, { cwd: rootDir, stdio: 'inherit' });
    console.log(`Created branch ${branchName}`);

    execSync(`git push -u origin ${branchName}`, { cwd: rootDir, stdio: 'inherit' });
    console.log(`Pushed ${branchName} to origin`);

    // Switch back to main and push version bump
    execSync('git checkout main', { cwd: rootDir, stdio: 'inherit' });
    execSync('git push origin main', { cwd: rootDir, stdio: 'inherit' });
    console.log('Pushed version bump to main');

    console.log('');
    console.log(`Release ${newVersion} initiated!`);
    console.log(`GitHub Actions will build and publish the release.`);
    console.log(`Watch progress at: https://github.com/jamesbillinger/agent-hub/actions`);
  } catch (e) {
    console.error('Error during git operations:', e.message);
    process.exit(1);
  }
}

// Check we're on main branch
try {
  const branch = execSync('git branch --show-current', { cwd: rootDir, encoding: 'utf8' }).trim();
  if (branch !== 'main' && branch !== 'master') {
    console.warn(`Warning: You're on branch '${branch}', not main/master.`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question('Continue anyway? (y/N) ', (answer) => {
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(1);
      }
      performRelease();
    });
  } else {
    performRelease();
  }
} catch (e) {
  console.warn('Warning: Could not determine current branch');
  performRelease();
}
