const fs = require('fs');
const path = require('path');
const config = require('../config');
const gpg = require('../gpg');
const pass = require('../pass');

async function run() {
  const checks = [];
  const cfg = config.load();

  checks.push(await check('gpg installed', async () => {
    if (!await gpg.isInstalled()) throw new Error('install with: brew install gnupg / apt install gnupg');
    return 'present';
  }));

  checks.push(await check('pass installed', async () => {
    if (!await pass.isInstalled()) throw new Error('install with: brew install pass / apt install pass');
    return 'present';
  }));

  checks.push(await check('zuul config', () => {
    if (!fs.existsSync(cfg._path)) throw new Error(`no config at ${cfg._path} — run: zuul setup`);
    return cfg._path;
  }));

  checks.push(await check('namespace', () => `${cfg.namespace}/  (override: ZUUL_NAMESPACE)`));

  checks.push(await check('bot key in keyring', async () => {
    if (!cfg.botKeyId) throw new Error('not configured — run: zuul setup');
    if (!await gpg.fingerprintExists(cfg.botKeyId)) throw new Error(`fingerprint ${cfg.botKeyId.slice(-16)} missing from keyring`);
    return cfg.botKeyId.slice(-16);
  }));

  checks.push(await check('human key in keyring', async () => {
    if (!cfg.humanKeyId) return { warn: 'not configured (bot-only setup)' };
    if (!await gpg.fingerprintExists(cfg.humanKeyId)) throw new Error(`fingerprint ${cfg.humanKeyId.slice(-16)} missing from keyring`);
    return cfg.humanKeyId.slice(-16);
  }));

  checks.push(await check('bot passphrase file', () => {
    if (!fs.existsSync(cfg.passphraseFile)) throw new Error(`missing: ${cfg.passphraseFile}`);
    const stat = fs.statSync(cfg.passphraseFile);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) return `present, but mode is ${mode.toString(8)} (should be 600)`;
    return cfg.passphraseFile;
  }));

  checks.push(await check('password store exists', () => {
    if (!fs.existsSync(cfg.passwordStore)) throw new Error(`missing: ${cfg.passwordStore}`);
    return cfg.passwordStore;
  }));

  checks.push(await check('namespace gpg-id', () => {
    const idFile = path.join(cfg.passwordStore, cfg.namespace, '.gpg-id');
    if (!fs.existsSync(idFile)) throw new Error(`${cfg.namespace}/ is not initialized in pass`);
    const ids = fs.readFileSync(idFile, 'utf8').trim().split('\n').filter(Boolean);
    if (ids.length < 2) {
      if (cfg.botKeyId && ids.includes(cfg.botKeyId)) {
        return `bot-only (${ids[0].slice(-16)})`;
      }
      return `single-recipient (${ids.join(', ')}) — bot may not be able to decrypt`;
    }
    return `${ids.length} recipients`;
  }));

  checks.push(await check('bot key unlocked', async () => {
    if (!cfg.botKeyId) throw new Error('not configured');
    if (!await gpg.isAgentUnlocked(cfg.botKeyId)) {
      throw new Error('agent cannot use bot key without prompt — run: zuul unlock');
    }
    return 'gpg-agent has the key';
  }));

  checks.push(await check('boot-time unlock installed', () => {
    if (cfg.bootUnlockInstalled) return 'installed';
    return { warn: 'not installed — agent will need `zuul unlock` after every reboot' };
  }));

  let failed = 0;
  let warned = 0;
  for (const c of checks) {
    if (c.status === 'ok') {
      process.stdout.write(`  ✓ ${c.name.padEnd(28)} ${c.detail}\n`);
    } else if (c.status === 'warn') {
      process.stdout.write(`  ! ${c.name.padEnd(28)} ${c.detail}\n`);
      warned++;
    } else {
      process.stdout.write(`  ✗ ${c.name.padEnd(28)} ${c.detail}\n`);
      failed++;
    }
  }

  process.stdout.write('\n');
  if (failed > 0) {
    process.stdout.write(`${failed} check(s) failed.\n`);
    const err = new Error('doctor found problems');
    err.exitCode = 1;
    throw err;
  }
  if (warned > 0) {
    process.stdout.write(`${warned} warning(s).\n`);
    return;
  }
  process.stdout.write('all clear.\n');
}

async function check(name, fn) {
  try {
    const result = await fn();
    if (result && typeof result === 'object' && result.warn) {
      return { name, status: 'warn', detail: result.warn };
    }
    return { name, status: 'ok', detail: result || '' };
  } catch (err) {
    return { name, status: 'fail', detail: err.message };
  }
}

module.exports = { run };
