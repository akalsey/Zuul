const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_NAMESPACE = 'bot';

function configDir() {
  if (process.env.ZUUL_CONFIG_DIR) return process.env.ZUUL_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(os.homedir(), '.config'), 'gatepass');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function passwordStoreDir() {
  return process.env.PASSWORD_STORE_DIR || path.join(os.homedir(), '.password-store');
}

function load() {
  const p = configPath();
  let onDisk = {};
  if (fs.existsSync(p)) {
    try {
      onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      throw new Error(`failed to parse ${p}: ${err.message}`);
    }
  }
  return {
    namespace: process.env.ZUUL_NAMESPACE || onDisk.namespace || DEFAULT_NAMESPACE,
    botKeyId: onDisk.botKeyId || null,
    humanKeyId: onDisk.humanKeyId || null,
    passphraseFile: onDisk.passphraseFile || path.join(os.homedir(), '.bot-pass.txt'),
    passwordStore: onDisk.passwordStore || passwordStoreDir(),
    bootUnlockInstalled: !!onDisk.bootUnlockInstalled,
    _path: p,
    _onDisk: onDisk,
  };
}

function save(updates) {
  const p = configPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const current = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  const next = { ...current, ...updates };
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

function isInitialized(cfg = load()) {
  return !!cfg.botKeyId;
}

function requireInitialized(cfg = load()) {
  if (!isInitialized(cfg)) {
    const err = new Error("gatepass is not configured yet. Run: gatepass setup");
    err.exitCode = 3;
    throw err;
  }
  return cfg;
}

module.exports = {
  DEFAULT_NAMESPACE,
  configDir,
  configPath,
  passwordStoreDir,
  load,
  save,
  isInitialized,
  requireInitialized,
};
