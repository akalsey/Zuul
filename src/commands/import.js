const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('../args');
const { run } = require('../exec');
const config = require('../config');
const gpg = require('../gpg');
const pass = require('../pass');
const prompt = require('../prompt');
const { installBotKey } = require('./import-key');

const SPEC = {
  'transit-passphrase-file': { },
  force:                     { boolean: true },
};

const DEFAULT_BUNDLE_PATH = '/run/secrets/zuul-export';
const DEFAULT_TRANSIT_PASS_PATH = '/run/secrets/zuul-export-pass';

async function importRun(argv) {
  const { positional, opts } = parseArgs(argv, SPEC);

  let bundlePath;
  if (positional.length === 1) {
    bundlePath = path.resolve(positional[0]);
  } else if (positional.length === 0 && fs.existsSync(DEFAULT_BUNDLE_PATH)) {
    bundlePath = DEFAULT_BUNDLE_PATH;
    process.stderr.write(`Auto-detected bundle at ${DEFAULT_BUNDLE_PATH}\n`);
  } else {
    usageError('zuul import <bundle> [--transit-passphrase-file FILE] [--force]');
  }

  if (!fs.existsSync(bundlePath)) {
    const err = new Error(`bundle file not found: ${bundlePath}`);
    err.exitCode = 64;
    throw err;
  }

  const transitPass = await collectTransitPassphrase(opts['transit-passphrase-file']);
  if (!transitPass) {
    const err = new Error('empty transit passphrase');
    err.exitCode = 64;
    throw err;
  }

  const interactive = !!(process.stdin.isTTY && process.stderr.isTTY);
  const force = !!opts.force;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zuul-import-'));
  try {
    fs.chmodSync(work, 0o700);

    const tarball = path.join(work, 'bundle.tgz');
    process.stderr.write('Decrypting bundle...\n');
    try {
      await gpg.symmetricDecrypt({ infile: bundlePath, outfile: tarball, passphrase: transitPass });
    } catch (err) {
      const wrapped = new Error(`failed to decrypt bundle (wrong transit passphrase?): ${err.message}`);
      wrapped.exitCode = 1;
      throw wrapped;
    }

    const extractDir = path.join(work, 'extract');
    fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
    await run('tar', ['-xzf', tarball, '-C', extractDir]);

    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw err1('bundle is missing manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 1) throw err1(`unsupported bundle version: ${manifest.version}`);
    if (!/^[A-F0-9]{40}$/i.test(manifest.botKeyId || '')) throw err1('bundle manifest has invalid botKeyId');

    process.stderr.write('Bundle:\n');
    process.stderr.write(`  exported from: ${manifest.exportedFrom || '(unknown)'}\n`);
    process.stderr.write(`  exported at:   ${manifest.exportedAt || '(unknown)'}\n`);
    process.stderr.write(`  type:          ${manifest.type}\n`);
    process.stderr.write(`  bot key:       ${manifest.botKeyId.slice(-16)}\n\n`);

    const cfg = config.load();

    if (cfg.botKeyId && cfg.botKeyId !== manifest.botKeyId) {
      process.stderr.write(`!! a different bot key is already configured: ${cfg.botKeyId.slice(-16)}\n`);
      process.stderr.write('   Replacing it orphans existing entries encrypted to the old key.\n');
      if (!force) {
        if (interactive) {
          if (!await prompt.confirm('Replace the configured bot key?', { defaultYes: false })) {
            process.stderr.write('aborted.\n');
            return;
          }
        } else {
          throw err1('refusing to replace existing bot key non-interactively (pass --force)');
        }
      }
    }

    const keyFile = path.join(extractDir, 'bot-key.asc');
    const passFile = path.join(extractDir, 'bot-pass.txt');
    if (!fs.existsSync(keyFile)) throw err1('bundle missing bot-key.asc');
    if (!fs.existsSync(passFile)) throw err1('bundle missing bot-pass.txt');

    process.stderr.write('Importing bot key into the GPG keyring...\n');
    const { all } = await gpg.importKeyFile(keyFile);
    if (!all.some((k) => k.fingerprint === manifest.botKeyId)) {
      throw err1(`bundle bot-key.asc does not contain the fingerprint claimed in the manifest`);
    }

    const passphrase = fs.readFileSync(passFile, 'utf8').replace(/\r?\n+$/, '');
    await installBotKey({
      fingerprint: manifest.botKeyId,
      passphrase,
      passphraseFile: cfg.passphraseFile,
    });

    if (manifest.namespace && manifest.namespace !== cfg.namespace) {
      config.save({ namespace: manifest.namespace });
      process.stderr.write(`  ✓ set namespace to ${manifest.namespace}\n`);
    }
    if (manifest.humanKeyId && !cfg.humanKeyId) {
      config.save({ humanKeyId: manifest.humanKeyId });
      process.stderr.write(`  ✓ recorded human key id ${manifest.humanKeyId.slice(-16)} (key not present locally)\n`);
    }

    const bundleStore = path.join(extractDir, 'password-store');
    if (fs.existsSync(bundleStore)) {
      await restorePasswordStore({ src: bundleStore, dst: cfg.passwordStore, force, interactive });
    }

    await checkRecipientMismatch({
      botKeyId: manifest.botKeyId,
      interactive,
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  process.stderr.write('\nDone. Verify with: zuul doctor\n');
  process.stderr.write('Wipe the bundle file once verification passes (e.g. shred -u).\n');
}

async function checkRecipientMismatch({ botKeyId, interactive }) {
  const cfg = config.load();
  const gpgIdFile = pass.effectiveGpgIdFile({
    passwordStore: cfg.passwordStore,
    namespace: cfg.namespace,
  });
  if (!gpgIdFile) return;

  const recipients = pass.readGpgIdRecipients(gpgIdFile);
  if (pass.gpgIdListsFingerprint(recipients, botKeyId)) return;

  process.stderr.write(`\n!! ${gpgIdFile} does not list the imported bot key.\n`);
  process.stderr.write(`   Recipients on file: ${recipients.join(', ') || '(none)'}\n`);
  process.stderr.write(`   New entries written here would not be readable by ${botKeyId.slice(-16)}.\n`);

  if (!interactive) {
    const err = new Error(
      `pass store recipient mismatch: ${gpgIdFile} does not list ${botKeyId.slice(-16)}. ` +
      `Re-run zuul import interactively, or run: pass init ${botKeyId}` +
      (cfg.humanKeyId ? ` ${cfg.humanKeyId}` : '')
    );
    err.exitCode = 1;
    throw err;
  }

  if (!await prompt.confirm('Re-init pass with the imported bot key as a recipient?', { defaultYes: true })) {
    process.stderr.write('  skipped — run `pass init` (or `zuul setup`) before adding entries.\n');
    return;
  }

  const reInit = cfg.humanKeyId ? [botKeyId, cfg.humanKeyId] : [botKeyId];
  process.stderr.write(`  re-initializing with ${reInit.map((r) => r.slice(-16)).join(' + ')}...\n`);
  try {
    await pass.initRecipients({
      passwordStore: cfg.passwordStore,
      subdir: cfg.namespace,
      recipients: reInit,
    });
    process.stderr.write(`  ✓ re-initialized ${cfg.namespace}/ — entries re-encrypted to the imported bot key\n`);
  } catch (err) {
    const wrapped = new Error(
      `pass init failed: ${err.message}\n` +
      `Existing entries may have been encrypted to a recipient whose secret key is not in this keyring. ` +
      `If so, decrypt them on the source machine and re-add via zuul add.`
    );
    wrapped.exitCode = 1;
    throw wrapped;
  }
}

async function restorePasswordStore({ src, dst, force, interactive }) {
  const dstExists = fs.existsSync(dst) && fs.readdirSync(dst).length > 0;
  if (dstExists) {
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const backup = `${dst}.bak-${ts}`;
    if (!force) {
      if (interactive) {
        process.stderr.write(`\n!! ${dst} already exists.\n`);
        if (!await prompt.confirm(`Move it to ${backup} and replace?`, { defaultYes: false })) {
          process.stderr.write('  skipped password store restore.\n');
          return;
        }
      } else {
        const err = new Error(`${dst} already exists; pass --force to replace (a backup is made first)`);
        err.exitCode = 1;
        throw err;
      }
    }
    fs.renameSync(dst, backup);
    process.stderr.write(`  ✓ moved existing store to ${backup}\n`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await run('cp', ['-R', src, dst]);
  process.stderr.write(`  ✓ restored password store to ${dst}\n`);
}

async function collectTransitPassphrase(flagPath) {
  if (flagPath) {
    const p = path.resolve(flagPath);
    if (!fs.existsSync(p)) {
      const err = new Error(`transit passphrase file not found: ${p}`);
      err.exitCode = 64;
      throw err;
    }
    return fs.readFileSync(p, 'utf8').replace(/\r?\n+$/, '');
  }
  if (fs.existsSync(DEFAULT_TRANSIT_PASS_PATH)) {
    process.stderr.write(`Auto-detected transit passphrase at ${DEFAULT_TRANSIT_PASS_PATH}\n`);
    return fs.readFileSync(DEFAULT_TRANSIT_PASS_PATH, 'utf8').replace(/\r?\n+$/, '');
  }
  return await prompt.readPassword('Transit passphrase: ');
}

function err1(msg) {
  const err = new Error(msg);
  err.exitCode = 1;
  return err;
}

function usageError(msg) {
  const err = new Error(msg);
  err.exitCode = 64;
  throw err;
}

module.exports = { run: importRun };
