# OpenClaw Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `@akalsey/openclaw-gatepass`, a separate npm package that installs the gatepass CLI and copies its skill files at install time, enabling one-command OpenClaw setup.

**Architecture:** A thin plugin package with an `openclaw.plugin.json` manifest and a `postinstall.js` script. Skills live only in `@akalsey/gatepass` and are copied into the plugin directory at npm install time by the postinstall script. The copy logic is extracted into a testable module.

**Tech Stack:** Node.js (built-in `fs`, `path`), npm postinstall scripts, OpenClaw plugin manifest format.

---

## File Map

### Changes to `/Users/akalsey/projects/gatepass/` (existing repo)
- Modify: `package.json` — add `"skills"` to `files` array

### New repo at `/Users/akalsey/projects/openclaw-gatepass/`
- Create: `package.json`
- Create: `openclaw.plugin.json`
- Create: `.gitignore`
- Create: `scripts/copy-skills.js` — pure copy logic, no side effects, testable
- Create: `scripts/postinstall.js` — resolves gatepass location, calls copy-skills
- Create: `test/copy-skills.test.js`
- Create: `skills/` — gitignored, assembled at install time

---

### Task 1: Publish gatepass skills directory

**Files:**
- Modify: `/Users/akalsey/projects/gatepass/package.json`

- [ ] **Step 1: Add `skills` to published files**

Edit `/Users/akalsey/projects/gatepass/package.json`. Change:

```json
"files": [
  "bin",
  "src",
  "README.md"
]
```

To:

```json
"files": [
  "bin",
  "src",
  "skills",
  "README.md"
]
```

- [ ] **Step 2: Commit**

```bash
cd /Users/akalsey/projects/gatepass
git add package.json
git commit -m "chore: include skills in published npm package"
```

---

### Task 2: Initialize openclaw-gatepass repo

**Files:**
- Create: `/Users/akalsey/projects/openclaw-gatepass/` (new git repo)
- Create: `/Users/akalsey/projects/openclaw-gatepass/.gitignore`
- Create: `/Users/akalsey/projects/openclaw-gatepass/package.json`
- Create: `/Users/akalsey/projects/openclaw-gatepass/openclaw.plugin.json`

- [ ] **Step 1: Initialize git repo**

```bash
mkdir /Users/akalsey/projects/openclaw-gatepass
cd /Users/akalsey/projects/openclaw-gatepass
git init
```

- [ ] **Step 2: Create `.gitignore`**

Create `/Users/akalsey/projects/openclaw-gatepass/.gitignore`:

```
node_modules/
skills/
```

- [ ] **Step 3: Create `package.json`**

Create `/Users/akalsey/projects/openclaw-gatepass/package.json`:

```json
{
  "name": "@akalsey/openclaw-gatepass",
  "version": "0.1.0",
  "description": "OpenClaw plugin for gatepass secrets management",
  "keywords": ["openclaw", "plugin", "secrets", "gatepass", "credentials"],
  "license": "MIT",
  "author": "Adam Kalsey",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/akalsey/openclaw-gatepass.git"
  },
  "files": [
    "scripts",
    "openclaw.plugin.json",
    "skills",
    "README.md"
  ],
  "scripts": {
    "postinstall": "node scripts/postinstall.js",
    "test": "node --test 'test/**/*.test.js'"
  },
  "dependencies": {
    "@akalsey/gatepass": "*"
  },
  "openclaw": {
    "compat": {
      "pluginApi": "1.0"
    }
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 4: Create `openclaw.plugin.json`**

Create `/Users/akalsey/projects/openclaw-gatepass/openclaw.plugin.json`:

```json
{
  "name": "@akalsey/openclaw-gatepass",
  "description": "Secrets management for OpenClaw agents via gatepass",
  "skills": ["skills/secrets-management"],
  "pluginApi": "1.0"
}
```

- [ ] **Step 5: Commit**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
git add .gitignore package.json openclaw.plugin.json
git commit -m "chore: initialize openclaw-gatepass package"
```

---

### Task 3: Write and test the copy-skills module

**Files:**
- Create: `/Users/akalsey/projects/openclaw-gatepass/scripts/copy-skills.js`
- Create: `/Users/akalsey/projects/openclaw-gatepass/test/copy-skills.test.js`

- [ ] **Step 1: Write the failing tests**

Create `/Users/akalsey/projects/openclaw-gatepass/test/copy-skills.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { copySkills } = require('../scripts/copy-skills');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-gatepass-test-'));
}

test('copies skill files to destination', () => {
  const tmp = tmpDir();
  const src = path.join(tmp, 'src-skills');
  const dest = path.join(tmp, 'dest-skills');

  fs.mkdirSync(path.join(src, 'secrets-management'), { recursive: true });
  fs.writeFileSync(path.join(src, 'secrets-management', 'SKILL.md'), '# Test Skill');

  copySkills(src, dest);

  const destFile = path.join(dest, 'secrets-management', 'SKILL.md');
  assert.ok(fs.existsSync(destFile), 'SKILL.md should exist in dest');
  assert.equal(fs.readFileSync(destFile, 'utf8'), '# Test Skill');

  fs.rmSync(tmp, { recursive: true });
});

test('copies nested subdirectories', () => {
  const tmp = tmpDir();
  const src = path.join(tmp, 'src-skills');
  const dest = path.join(tmp, 'dest-skills');

  fs.mkdirSync(path.join(src, 'secrets-management'), { recursive: true });
  fs.writeFileSync(path.join(src, 'secrets-management', 'SKILL.md'), '# Skill');
  fs.writeFileSync(path.join(src, 'secrets-management', 'setup.md'), '# Setup');
  fs.writeFileSync(path.join(src, 'secrets-management', 'security.md'), '# Security');

  copySkills(src, dest);

  assert.ok(fs.existsSync(path.join(dest, 'secrets-management', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dest, 'secrets-management', 'setup.md')));
  assert.ok(fs.existsSync(path.join(dest, 'secrets-management', 'security.md')));

  fs.rmSync(tmp, { recursive: true });
});

test('overwrites existing destination files', () => {
  const tmp = tmpDir();
  const src = path.join(tmp, 'src-skills');
  const dest = path.join(tmp, 'dest-skills');

  fs.mkdirSync(path.join(src, 'secrets-management'), { recursive: true });
  fs.writeFileSync(path.join(src, 'secrets-management', 'SKILL.md'), '# New Content');

  fs.mkdirSync(path.join(dest, 'secrets-management'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'secrets-management', 'SKILL.md'), '# Old Content');

  copySkills(src, dest);

  assert.equal(
    fs.readFileSync(path.join(dest, 'secrets-management', 'SKILL.md'), 'utf8'),
    '# New Content'
  );

  fs.rmSync(tmp, { recursive: true });
});

test('does not throw when source does not exist', () => {
  const tmp = tmpDir();
  const src = path.join(tmp, 'nonexistent');
  const dest = path.join(tmp, 'dest');

  assert.doesNotThrow(() => copySkills(src, dest));

  fs.rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
node --test 'test/**/*.test.js'
```

Expected: all 4 tests fail with `Cannot find module '../scripts/copy-skills'`

- [ ] **Step 3: Create `scripts/` directory and write `copy-skills.js`**

```bash
mkdir /Users/akalsey/projects/openclaw-gatepass/scripts
```

Create `/Users/akalsey/projects/openclaw-gatepass/scripts/copy-skills.js`:

```javascript
const fs = require('fs');
const path = require('path');

function copySkills(src, dest) {
  if (!fs.existsSync(src)) {
    process.stderr.write(`openclaw-gatepass: skills source not found at ${src} — skipping\n`);
    return;
  }
  copyDir(src, dest);
  process.stdout.write('openclaw-gatepass: gatepass skills installed\n');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = { copySkills };
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
node --test 'test/**/*.test.js'
```

Expected: all 4 tests pass

- [ ] **Step 5: Commit**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
git add scripts/copy-skills.js test/copy-skills.test.js
git commit -m "feat: add copy-skills module with tests"
```

---

### Task 4: Write postinstall script

**Files:**
- Create: `/Users/akalsey/projects/openclaw-gatepass/scripts/postinstall.js`

- [ ] **Step 1: Write `postinstall.js`**

Create `/Users/akalsey/projects/openclaw-gatepass/scripts/postinstall.js`:

```javascript
const path = require('path');
const { copySkills } = require('./copy-skills');

try {
  const gatepassPkg = require.resolve('@akalsey/gatepass/package.json');
  const sourceSkills = path.join(path.dirname(gatepassPkg), 'skills');
  const destSkills = path.join(__dirname, '..', 'skills');
  copySkills(sourceSkills, destSkills);
} catch (err) {
  process.stderr.write(`openclaw-gatepass: could not install skills: ${err.message}\n`);
}
```

- [ ] **Step 2: Install dependencies and run postinstall manually to verify**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
npm install
node scripts/postinstall.js
```

Expected output: `openclaw-gatepass: gatepass skills installed`

- [ ] **Step 3: Verify skills were copied**

```bash
ls /Users/akalsey/projects/openclaw-gatepass/skills/secrets-management/
```

Expected: `SKILL.md  security.md  setup.md`

- [ ] **Step 4: Commit**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
git add scripts/postinstall.js
git commit -m "feat: add postinstall script to copy skills from gatepass"
```

---

### Task 5: Write README and publish

**Files:**
- Create: `/Users/akalsey/projects/openclaw-gatepass/README.md`

- [ ] **Step 1: Write README**

Create `/Users/akalsey/projects/openclaw-gatepass/README.md`:

```markdown
# @akalsey/openclaw-gatepass

OpenClaw plugin for [gatepass](https://github.com/akalsey/gatepass) secrets management.

Installs the `gatepass` CLI and the `secrets-management` skill in one step.

## Installation

```
clawhub install @akalsey/openclaw-gatepass
```

Or via npm:

```
npm install @akalsey/openclaw-gatepass
```

## What it installs

- **`gatepass` CLI** — decrypt and retrieve secrets stored in `pass`
- **`secrets-management` skill** — agent instructions for retrieving credentials at the moment of use

## Updating skills

Skills are pulled from the installed `@akalsey/gatepass` package at install time. To get updated skills, update the plugin:

```
npm update @akalsey/openclaw-gatepass
```
```

- [ ] **Step 2: Commit README**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
git add README.md
git commit -m "docs: add README"
```

- [ ] **Step 3: Run full test suite one final time**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
npm test
```

Expected: all 4 tests pass, no errors

- [ ] **Step 4: Create GitHub repo and push**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
gh repo create akalsey/openclaw-gatepass --public --source=. --remote=origin --push
```

- [ ] **Step 5: Publish to npm**

```bash
cd /Users/akalsey/projects/openclaw-gatepass
npm publish --access public
```
