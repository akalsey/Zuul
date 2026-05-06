const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run, which } = require('./exec');

async function isInstalled() {
  return (await which('gpg')) !== null;
}

async function listSecretKeys() {
  try {
    const { stdout } = await run('gpg', ['--list-secret-keys', '--with-colons']);
    return parseColons(stdout);
  } catch {
    return [];
  }
}

function parseColons(text) {
  const records = [];
  let current = null;
  for (const line of text.split('\n')) {
    const fields = line.split(':');
    const type = fields[0];
    if (type === 'sec') {
      if (current) records.push(current);
      current = { fingerprint: null, keyid: fields[4], uids: [], created: fields[5], expires: fields[6] || null };
    } else if (type === 'fpr' && current && !current.fingerprint) {
      current.fingerprint = fields[9];
    } else if (type === 'uid' && current) {
      current.uids.push(fields[9]);
    }
  }
  if (current) records.push(current);
  return records;
}

async function fingerprintExists(fpr) {
  if (!fpr) return false;
  const keys = await listSecretKeys();
  return keys.some((k) => k.fingerprint === fpr);
}

async function importKeyFile(filepath) {
  if (!fs.existsSync(filepath)) {
    const err = new Error(`key file not found: ${filepath}`);
    err.exitCode = 64;
    throw err;
  }
  const before = new Set((await listSecretKeys()).map((k) => k.fingerprint));
  await run('gpg', ['--batch', '--yes', '--import', filepath]);
  const afterKeys = await listSecretKeys();
  const added = afterKeys.filter((k) => !before.has(k.fingerprint));
  return { added, all: afterKeys };
}

async function generateKey({ name, email, passphrase, comment }) {
  const before = new Set((await listSecretKeys()).map((k) => k.fingerprint));
  const batch = [
    '%echo generating key',
    'Key-Type: RSA',
    'Key-Length: 4096',
    'Subkey-Type: RSA',
    'Subkey-Length: 4096',
    `Name-Real: ${name}`,
    comment ? `Name-Comment: ${comment}` : null,
    `Name-Email: ${email}`,
    'Expire-Date: 0',
    passphrase ? `Passphrase: ${passphrase}` : '%no-protection',
    '%commit',
    '%echo done',
  ].filter(Boolean).join('\n') + '\n';

  await run('gpg', ['--batch', '--pinentry-mode', 'loopback', '--gen-key'], { input: batch });

  const after = await listSecretKeys();
  const created = after.find((k) => !before.has(k.fingerprint));
  if (created) return created.fingerprint;
  const match = after.find((k) => k.uids.some((uid) => uid.includes(`<${email}>`)));
  if (!match) throw new Error('key generation reported success but no matching key was found');
  return match.fingerprint;
}

function generatePassphrase() {
  return crypto.randomBytes(32).toString('base64').replace(/[+/=]/g, '').slice(0, 40);
}

async function writeAgentConfig() {
  const gpgHome = process.env.GNUPGHOME || path.join(os.homedir(), '.gnupg');
  fs.mkdirSync(gpgHome, { recursive: true, mode: 0o700 });

  const gpgConf = path.join(gpgHome, 'gpg.conf');
  const agentConf = path.join(gpgHome, 'gpg-agent.conf');

  ensureLine(gpgConf, 'pinentry-mode loopback');
  ensureLine(agentConf, 'allow-loopback-pinentry');
  ensureLine(agentConf, 'default-cache-ttl 31536000');
  ensureLine(agentConf, 'max-cache-ttl 31536000');

  try { await run('gpgconf', ['--reload', 'gpg-agent']); } catch { /* agent may not be running */ }
}

function ensureLine(file, line) {
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = content.split('\n').map((l) => l.trim());
  const key = line.split(' ')[0];
  const filtered = lines.filter((l) => !l.startsWith(`${key} `) && l !== key);
  filtered.push(line);
  const out = filtered.filter((l, i, a) => l !== '' || i === a.length - 1).join('\n');
  fs.writeFileSync(file, out.endsWith('\n') ? out : out + '\n', { mode: 0o600 });
}

async function setOwnerTrust(fingerprint, level = 6) {
  if (!/^[A-F0-9]{40}$/i.test(fingerprint)) {
    throw new Error(`refusing to set ownertrust on suspicious fingerprint: ${fingerprint}`);
  }
  await run('gpg', ['--batch', '--import-ownertrust'], { input: `${fingerprint}:${level}:\n` });
}

async function exportSecretKey(fingerprint) {
  if (!/^[A-F0-9]{40}$/i.test(fingerprint)) {
    throw new Error(`invalid fingerprint: ${fingerprint}`);
  }
  const { stdout } = await run('gpg', ['--armor', '--export-secret-keys', fingerprint]);
  if (!stdout.includes('BEGIN PGP PRIVATE KEY')) {
    throw new Error(`gpg --export-secret-keys returned no key material for ${fingerprint}`);
  }
  return stdout;
}

async function symmetricEncrypt({ infile, outfile, passphrase }) {
  await run('gpg', [
    '--batch', '--yes',
    '--quiet',
    '--no-symkey-cache',
    '--pinentry-mode', 'loopback',
    '--passphrase-fd', '0',
    '--cipher-algo', 'AES256',
    '--symmetric',
    '--output', outfile,
    infile,
  ], { input: passphrase });
}

async function symmetricDecrypt({ infile, outfile, passphrase }) {
  await run('gpg', [
    '--batch', '--yes',
    '--quiet',
    '--no-symkey-cache',
    '--pinentry-mode', 'loopback',
    '--passphrase-fd', '0',
    '--decrypt',
    '--output', outfile,
    infile,
  ], { input: passphrase });
}

async function unlockBotKey({ fingerprint, passphraseFile }) {
  if (!fs.existsSync(passphraseFile)) {
    throw new Error(`passphrase file missing: ${passphraseFile}`);
  }
  await run('gpg', [
    '--batch', '--yes',
    '--pinentry-mode', 'loopback',
    '--passphrase-file', passphraseFile,
    '--local-user', fingerprint,
    '--sign',
  ], { input: 'zuul-unlock' });
}

async function isAgentUnlocked(fingerprint) {
  try {
    await run('gpg', [
      '--batch',
      '--pinentry-mode', 'loopback',
      '--passphrase', '',
      '--local-user', fingerprint,
      '--sign',
    ], { input: 'zuul-test' });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  isInstalled,
  listSecretKeys,
  fingerprintExists,
  importKeyFile,
  generateKey,
  generatePassphrase,
  writeAgentConfig,
  setOwnerTrust,
  exportSecretKey,
  symmetricEncrypt,
  symmetricDecrypt,
  unlockBotKey,
  isAgentUnlocked,
};
