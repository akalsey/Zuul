# Passkey Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WebAuthn passkey storage and registration to Zuul so bots can authenticate to services using passkeys via their browser automation tool.

**Architecture:** A shared `src/passkey.js` module holds validation logic (used by both `zuul add` and `zuul passkey-register`). The `passkey-register` command uses Playwright as a soft runtime dependency — checked and optionally installed at runtime. Passkey credentials are stored as base64-encoded JSON blobs in the standard `key: value` entry format.

**Tech Stack:** Node.js 18+ built-in `node:test` for tests, `node:crypto` for PKCS#8 validation, Playwright (soft dep) for browser-based registration via CDP WebAuthn API.

**Spec:** `docs/superpowers/specs/2026-05-10-passkey-support-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/passkey.js` | **Create** | Shared blob validation and credential serialization |
| `src/commands/passkey-register.js` | **Create** | New `zuul passkey-register` command |
| `src/commands/add.js` | **Modify** | Add `passkey` to SPEC, collectFlagFields, interactive prompt |
| `src/cli.js` | **Modify** | Register `passkey-register` in COMMANDS map |
| `skills/secrets-management/SKILL.md` | **Modify** | Add `passkey` field to table and new rule |
| `docs/passkey-automation.md` | **Create** | Agent-facing guide: decode blob + virtual authenticator examples |
| `test/passkey.test.js` | **Create** | Unit tests for `src/passkey.js` |
| `package.json` | **Modify** | Add `test` script |

---

## Task 1: Test infrastructure

**Files:**
- Modify: `package.json`

Zuul has no test runner configured. Node 18+ ships `node:test` — no install needed.

- [ ] **Step 1: Add test script to package.json**

Open `package.json` and add to `"scripts"`:

```json
"test": "node --test 'test/**/*.test.js'"
```

- [ ] **Step 2: Create test directory and smoke test**

```bash
mkdir test
```

Create `test/smoke.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: `✔ test runner works` and exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json test/smoke.test.js
git commit -m "chore: add node:test runner"
```

---

## Task 2: `src/passkey.js` — shared validation module

**Files:**
- Create: `src/passkey.js`
- Create: `test/passkey.test.js`

This module holds two pure functions used by both `add.js` and `passkey-register.js`:
- `validateBlob(value)` — validates a base64 JSON credential blob, returns `{ ok, parsed?, message? }`
- `blobFromCredential(credential)` — serializes a CDP credential object to a base64 JSON blob

- [ ] **Step 1: Write failing tests**

Create `test/passkey.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateBlob, blobFromCredential } = require('../src/passkey');

// Generate a real PKCS#8 EC key for use in tests
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const validPrivateKeyB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

function makeBlob(overrides = {}) {
  const obj = {
    credentialId: Buffer.from('testcredid').toString('base64'),
    privateKey: validPrivateKeyB64,
    rpId: 'example.com',
    userHandle: Buffer.from('user1').toString('base64'),
    signCount: 0,
    isResidentCredential: true,
    ...overrides,
  };
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

test('validateBlob: valid blob returns ok', () => {
  const result = validateBlob(makeBlob());
  assert.equal(result.ok, true);
  assert.equal(result.parsed.rpId, 'example.com');
});

test('validateBlob: not base64 JSON returns error', () => {
  const result = validateBlob('not-valid-base64!!!');
  assert.equal(result.ok, false);
  assert.match(result.message, /not valid base64-encoded JSON/);
});

test('validateBlob: valid base64 but not JSON returns error', () => {
  const result = validateBlob(Buffer.from('hello world').toString('base64'));
  assert.equal(result.ok, false);
  assert.match(result.message, /not valid base64-encoded JSON/);
});

test('validateBlob: missing credentialId returns error', () => {
  const result = validateBlob(makeBlob({ credentialId: undefined }));
  assert.equal(result.ok, false);
  assert.match(result.message, /missing required field 'credentialId'/);
});

test('validateBlob: missing privateKey returns error', () => {
  const result = validateBlob(makeBlob({ privateKey: undefined }));
  assert.equal(result.ok, false);
  assert.match(result.message, /missing required field 'privateKey'/);
});

test('validateBlob: missing rpId returns error', () => {
  const result = validateBlob(makeBlob({ rpId: undefined }));
  assert.equal(result.ok, false);
  assert.match(result.message, /missing required field 'rpId'/);
});

test('validateBlob: invalid PKCS#8 key returns error', () => {
  const result = validateBlob(makeBlob({ privateKey: Buffer.from('notakey').toString('base64') }));
  assert.equal(result.ok, false);
  assert.match(result.message, /not valid PKCS#8/);
});

test('blobFromCredential: round-trips through validateBlob', () => {
  const credential = {
    credentialId: Buffer.from('testcredid').toString('base64'),
    privateKey: validPrivateKeyB64,
    rpId: 'example.com',
    userHandle: Buffer.from('user1').toString('base64'),
    signCount: 0,
    isResidentCredential: true,
  };
  const blob = blobFromCredential(credential);
  const result = validateBlob(blob);
  assert.equal(result.ok, true);
  assert.equal(result.parsed.rpId, 'example.com');
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test
```

Expected: `Error: Cannot find module '../src/passkey'`

- [ ] **Step 3: Implement `src/passkey.js`**

Create `src/passkey.js`:

```js
const crypto = require('node:crypto');

function validateBlob(value) {
  let parsed;
  try {
    const buf = Buffer.from(value, 'base64');
    parsed = JSON.parse(buf.toString());
  } catch {
    return { ok: false, message: 'passkey: not valid base64-encoded JSON' };
  }

  for (const field of ['credentialId', 'privateKey', 'rpId']) {
    if (!parsed[field] || typeof parsed[field] !== 'string') {
      return { ok: false, message: `passkey: missing required field '${field}'` };
    }
  }

  try {
    crypto.createPrivateKey({
      key: Buffer.from(parsed.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    return {
      ok: false,
      message: "passkey: privateKey is not valid PKCS#8 — check the blob came from zuul passkey-register",
    };
  }

  return { ok: true, parsed };
}

function blobFromCredential(credential) {
  return Buffer.from(JSON.stringify(credential)).toString('base64');
}

module.exports = { validateBlob, blobFromCredential };
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test
```

Expected: all 8 passkey tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/passkey.js test/passkey.test.js
git commit -m "feat(passkey): add passkey validation module"
```

---

## Task 3: Update `src/commands/add.js`

**Files:**
- Modify: `src/commands/add.js`

Three changes: add `passkey` to `SPEC`, add it to `collectFlagFields`, add prompt + validation to `run()`.

- [ ] **Step 1: Add `passkey` to `SPEC`**

In `add.js`, find the `SPEC` object (lines 7–14) and add the `passkey` entry after `note`:

```js
const SPEC = {
  user:    { short: 'u', summary: 'username / login' },
  url:     {              summary: 'service URL' },
  email:   {              summary: 'email address (when distinct from user)' },
  otp:     {              summary: 'TOTP secret (otpauth:// URI or base32)' },
  note:    {              summary: 'free-form note' },
  passkey: {              summary: 'WebAuthn credential blob (base64 JSON, from zuul passkey-register)' },
  field:   { short: 'F', repeatable: true, summary: 'extra field as key=value (repeatable)' },
};
```

- [ ] **Step 2: Add `passkey` to `collectFlagFields`**

Find `collectFlagFields` (line 134). Change:

```js
for (const k of ['user', 'url', 'email', 'otp', 'note']) {
```

to:

```js
for (const k of ['user', 'url', 'email', 'otp', 'note', 'passkey']) {
```

- [ ] **Step 3: Add `require` for passkey module**

At the top of `add.js`, add after the existing requires:

```js
const { validateBlob } = require('../passkey');
```

- [ ] **Step 4: Add prompt and validation to `run()`**

After the OTP verify block (lines 92–95) and before `readMultilineFields`, add:

```js
  if (!fields.passkey) {
    const v = await prompt.ask('Passkey credential blob (base64 JSON, from zuul passkey-register) (optional)');
    if (v) fields.passkey = v;
  }

  if (fields.passkey) {
    const check = validateBlob(fields.passkey);
    if (!check.ok) {
      process.stderr.write(`\n${check.message}\n`);
      process.stderr.write('aborted — credential not saved.\n');
      return;
    }
  }
```

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: all tests still pass.

- [ ] **Step 6: Manual smoke test**

```bash
node bin/zuul.js add --help
```

Expected: `--passkey` appears in the flags list.

- [ ] **Step 7: Commit**

```bash
git add src/commands/add.js
git commit -m "feat(passkey): add --passkey flag to zuul add"
```

---

## Task 4: Create `src/commands/passkey-register.js`

**Files:**
- Create: `src/commands/passkey-register.js`

This command: checks/installs Playwright, looks up the service URL, opens a browser with a CDP virtual authenticator, waits for registration, then stores the credential.

- [ ] **Step 1: Create the file**

Create `src/commands/passkey-register.js`:

```js
const path = require('node:path');
const config = require('../config');
const pass = require('../pass');
const prompt = require('../prompt');
const { run: execRun, ExecError } = require('../exec');
const { validateBlob, blobFromCredential } = require('../passkey');

const PLAYWRIGHT_TIMEOUT_MS = 120_000;
const ZUUL_PKG_DIR = path.join(__dirname, '..', '..');

function usage() {
  process.stderr.write(
    'Usage: zuul passkey-register <service>\n' +
    '\n' +
    'Registers a WebAuthn passkey for a service using a Playwright virtual\n' +
    'authenticator, then stores the credential so the agent can use it.\n' +
    '\n' +
    'Requires Playwright (will offer to install if missing).\n'
  );
}

async function ensurePlaywright() {
  const resolveOpts = { paths: [ZUUL_PKG_DIR] };
  try {
    require.resolve('playwright', resolveOpts);
    return;
  } catch {
    // not installed
  }

  const ok = await prompt.confirm('Playwright is required for passkey registration. Install it now?');
  if (!ok) {
    process.stderr.write(`Install manually with: npm install --prefix ${ZUUL_PKG_DIR} playwright\n`);
    const err = new Error('Playwright not installed');
    err.exitCode = 5;
    throw err;
  }

  process.stderr.write('Installing Playwright...\n');
  try {
    await execRun('npm', ['install', '--prefix', ZUUL_PKG_DIR, 'playwright'], { capture: false });
  } catch (err) {
    process.stderr.write(`Playwright install failed. Try manually: npm install --prefix ${ZUUL_PKG_DIR} playwright\n`);
    const e = new Error('Playwright install failed');
    e.exitCode = 5;
    throw e;
  }

  try {
    require.resolve('playwright', resolveOpts);
  } catch {
    process.stderr.write(`Playwright install failed. Try manually: npm install --prefix ${ZUUL_PKG_DIR} playwright\n`);
    const err = new Error('Playwright install failed');
    err.exitCode = 5;
    throw err;
  }
}

async function resolveUrl(cfg, entry) {
  try {
    const text = await pass.show({ passwordStore: cfg.passwordStore, entry });
    const { fields } = pass.parseEntry(text);
    if (fields.url) return fields.url;
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const v = await prompt.ask('Service URL for passkey registration');
    if (v.startsWith('https://') || v.startsWith('http://')) return v;
    process.stderr.write('invalid URL — must start with http:// or https://\n');
  }
  const err = new Error('no valid URL provided');
  err.exitCode = 1;
  throw err;
}

async function run(argv) {
  const service = argv[0];
  if (!service || service.startsWith('-')) {
    usage();
    const err = new Error('missing service name');
    err.exitCode = 64;
    throw err;
  }

  prompt.ensureTTY();
  const cfg = config.requireInitialized();
  const entry = `${cfg.namespace}/${service}`;

  await ensurePlaywright();

  const serviceUrl = await resolveUrl(cfg, entry);

  const resolveOpts = { paths: [ZUUL_PKG_DIR] };
  const { chromium } = require(require.resolve('playwright', resolveOpts));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  try {
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });
  } catch (err) {
    await browser.close();
    process.stderr.write(
      `Could not inject virtual authenticator — ensure your Playwright version supports CDP WebAuthn (requires Chromium). Error: ${err.message}\n`
    );
    const e = new Error('virtual authenticator injection failed');
    e.exitCode = 1;
    throw e;
  }

  await page.goto(serviceUrl);
  process.stderr.write('Complete passkey registration in the browser window. Press Ctrl+C to cancel.\n');

  let credential;
  try {
    credential = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error('timeout'), { isTimeout: true }));
      }, PLAYWRIGHT_TIMEOUT_MS);

      cdp.on('WebAuthn.credentialAdded', (event) => {
        clearTimeout(timer);
        resolve(event.credential);
      });
    });
  } catch (err) {
    if (err.isTimeout) {
      process.stderr.write(
        'Timed out waiting for passkey registration (120s). The browser window will stay open — run zuul passkey-register again if you want to retry.\n'
      );
    }
    await browser.close();
    const e = new Error('passkey registration did not complete');
    e.exitCode = 1;
    throw e;
  }

  await browser.close();

  // blobFromCredential serializes the CDP credential; validateBlob then verifies
  // that credentialId, privateKey, and rpId are present and the key is valid PKCS#8.
  // This catches any malformed CDP event payloads before writing to the store.
  const blob = blobFromCredential(credential);
  const check = validateBlob(blob);
  if (!check.ok) {
    process.stderr.write(`\n${check.message}\n`);
    const err = new Error('generated credential failed validation');
    err.exitCode = 1;
    throw err;
  }

  // Load existing entry (if any), update passkey field, write back
  let password = '';
  let fields = {};
  try {
    const text = await pass.show({ passwordStore: cfg.passwordStore, entry });
    ({ password, fields } = pass.parseEntry(text));
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
  }

  fields.passkey = blob;
  const content = pass.formatEntry({ password, fields });
  await pass.insert({ passwordStore: cfg.passwordStore, entry, content });

  process.stderr.write(`\nPasskey stored. The agent can now authenticate to ${service} with:\n  zuul get ${service}\n`);
}

module.exports = { run };
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all tests still pass (no new tests needed — Playwright I/O is not unit-testable).

- [ ] **Step 3: Commit**

```bash
git add src/commands/passkey-register.js
git commit -m "feat(passkey): add zuul passkey-register command"
```

---

## Task 5: Register command in `src/cli.js`

**Files:**
- Modify: `src/cli.js`

- [ ] **Step 1: Add to COMMANDS map**

In `cli.js`, add `'passkey-register'` to `COMMANDS` following the `'import-key'` pattern:

```js
const COMMANDS = {
  get:               { module: './commands/get',               summary: 'Retrieve a credential by name' },
  list:              { module: './commands/list',              summary: 'List available credentials' },
  add:               { module: './commands/add',               summary: 'Add or update a credential (interactive)' },
  remove:            { module: './commands/remove',            summary: 'Remove a credential' },
  setup:             { module: './commands/setup',             summary: 'First-time setup: generate keys, configure GPG, init pass' },
  export:            { module: './commands/export',            summary: 'Export bot key (and optionally password store) as an encrypted bundle' },
  import:            { module: './commands/import',            summary: 'Import an encrypted bundle produced by zuul export' },
  'import-key':      { module: './commands/import-key',        summary: 'Import a raw GPG key file (optionally as bot/personal key)' },
  'passkey-register':{ module: './commands/passkey-register',  summary: 'Register a passkey for a service using a browser' },
  unlock:            { module: './commands/unlock',            summary: 'Unlock the bot key for the current session (boot-time)' },
  doctor:            { module: './commands/doctor',            summary: 'Diagnose configuration and runtime issues' },
};
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Manual smoke test**

```bash
node bin/zuul.js --help
```

Expected: `passkey-register` appears in the commands list.

```bash
node bin/zuul.js passkey-register --help
```

Expected: usage text from `passkey-register.js`.

- [ ] **Step 4: Commit**

```bash
git add src/cli.js
git commit -m "feat(passkey): register passkey-register command in CLI dispatcher"
```

---

## Task 6: Update agent skill

**Files:**
- Modify: `skills/secrets-management/SKILL.md`

- [ ] **Step 1: Add `passkey` to the standard fields table**

Find the table in `SKILL.md` (the one with `user`, `url`, `email`, `otp`, `note`) and add a row:

```markdown
| `passkey` | WebAuthn credential blob (base64 JSON). When present, use passkey authentication — do not type a password. Decode and load into your browser automation tool's virtual authenticator before navigating to the login page. See `docs/passkey-automation.md` for examples. |
```

- [ ] **Step 2: Add passkey login rule**

Find the `## Rules` section and add after the existing rules:

```markdown
- **If a credential has a `passkey:` field,** authenticate using the passkey credential rather than the password. The `passkey:` value is a base64-encoded JSON blob. Load it into your browser automation tool's virtual authenticator before navigating to the login page. The password field may also be present but should be ignored for login.
```

- [ ] **Step 3: Commit**

```bash
git add skills/secrets-management/SKILL.md
git commit -m "docs(skill): add passkey field and authentication rule"
```

---

## Task 7: Write `docs/passkey-automation.md`

**Files:**
- Create: `docs/passkey-automation.md`

- [ ] **Step 1: Create the file**

Create `docs/passkey-automation.md`:

````markdown
# Using Passkeys in Browser Automation

When `zuul get <service>` returns a `passkey:` field, the value is a base64-encoded JSON blob containing a WebAuthn credential. Load it into a virtual authenticator before navigating to the login page.

## Decode the blob

```js
const credential = JSON.parse(Buffer.from(passkey, 'base64').toString());
```

## Field mapping

| Zuul blob field | CDP `addCredential` parameter |
|---|---|
| `credentialId` | `credentialId` |
| `privateKey` | `privateKey` |
| `rpId` | `rpId` |
| `userHandle` | `userHandle` |
| `isResidentCredential` | `isResidentCredential` |
| `signCount` | use `0` (see note below) |

## Sign count note

The `signCount` in the stored blob becomes stale after each login because the service increments it. Pass `signCount: 0` to `addCredential` to disable counter enforcement — this is the correct approach for bot use.

## Playwright

```js
const { chromium } = require('playwright');

async function loginWithPasskey(url, passkeyBlob) {
  const credential = JSON.parse(Buffer.from(passkeyBlob, 'base64').toString());

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: credential.credentialId,
      privateKey: credential.privateKey,
      rpId: credential.rpId,
      userHandle: credential.userHandle ?? '',
      isResidentCredential: credential.isResidentCredential ?? true,
      signCount: 0,
    },
  });

  await page.goto(url);
  // The browser will now use the virtual authenticator when the site triggers WebAuthn
}
```

## Puppeteer

```js
const puppeteer = require('puppeteer');

async function loginWithPasskey(url, passkeyBlob) {
  const credential = JSON.parse(Buffer.from(passkeyBlob, 'base64').toString());

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();

  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: credential.credentialId,
      privateKey: credential.privateKey,
      rpId: credential.rpId,
      userHandle: credential.userHandle ?? '',
      isResidentCredential: credential.isResidentCredential ?? true,
      signCount: 0,
    },
  });

  await page.goto(url);
}
```

## Selenium (Chromium)

Selenium's WebAuthn support uses the same CDP protocol when driving Chromium via ChromeDriver.

```python
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
import json, base64

def login_with_passkey(url, passkey_blob):
    credential = json.loads(base64.b64decode(passkey_blob))

    options = Options()
    driver = webdriver.Chrome(options=options)

    driver.execute_cdp_cmd('WebAuthn.enable', {'enableUI': False})
    result = driver.execute_cdp_cmd('WebAuthn.addVirtualAuthenticator', {
        'options': {
            'protocol': 'ctap2',
            'transport': 'internal',
            'hasResidentKey': True,
            'hasUserVerification': True,
            'isUserVerified': True,
        }
    })
    authenticator_id = result['authenticatorId']

    driver.execute_cdp_cmd('WebAuthn.addCredential', {
        'authenticatorId': authenticator_id,
        'credential': {
            'credentialId': credential['credentialId'],
            'privateKey': credential['privateKey'],
            'rpId': credential['rpId'],
            'userHandle': credential.get('userHandle', ''),
            'isResidentCredential': credential.get('isResidentCredential', True),
            'signCount': 0,
        }
    })

    driver.get(url)
```

Note: Selenium WebAuthn CDP support requires ChromeDriver 115+ and is less well-documented than Playwright/Puppeteer. If you encounter issues, Playwright is the more reliable choice.
````

- [ ] **Step 2: Commit**

```bash
git add docs/passkey-automation.md
git commit -m "docs: add passkey-automation guide for browser automation tools"
```

---

## Task 8: Delete smoke test

The smoke test in Task 1 was scaffolding. Remove it now that real tests exist.

- [ ] **Step 1: Remove smoke test**

```bash
rm test/smoke.test.js
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: only the passkey tests run, all pass.

- [ ] **Step 3: Commit**

```bash
git rm test/smoke.test.js
git commit -m "chore: remove scaffolding smoke test"
```
