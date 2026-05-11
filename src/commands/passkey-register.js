const path = require('node:path');
const config = require('../config');
const pass = require('../pass');
const prompt = require('../prompt');
const { run: execRun } = require('../exec');
const { validateBlob, blobFromCredential } = require('../passkey');

const PLAYWRIGHT_TIMEOUT_MS = 120_000;
const ZUUL_PKG_DIR = path.join(__dirname, '..', '..');
const PLAYWRIGHT_RESOLVE_OPTS = { paths: [ZUUL_PKG_DIR] };

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

function playwrightInstallFailedError() {
  process.stderr.write(`Playwright install failed. Try manually: npm install --prefix ${ZUUL_PKG_DIR} playwright\n`);
  const err = new Error('Playwright install failed');
  err.exitCode = 5;
  return err;
}

async function ensurePlaywright() {
  try {
    require.resolve('playwright', PLAYWRIGHT_RESOLVE_OPTS);
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
  } catch {
    throw playwrightInstallFailedError();
  }

  try {
    require.resolve('playwright', PLAYWRIGHT_RESOLVE_OPTS);
  } catch {
    throw playwrightInstallFailedError();
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

  const { chromium } = require(require.resolve('playwright', PLAYWRIGHT_RESOLVE_OPTS));

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

  // Validate before writing — catches malformed CDP event payloads early.
  const blob = blobFromCredential(credential);
  const check = validateBlob(blob);
  if (!check.ok) {
    process.stderr.write(`\n${check.message}\n`);
    const err = new Error('generated credential failed validation');
    err.exitCode = 1;
    throw err;
  }

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
