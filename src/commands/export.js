const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('../args');
const { run } = require('../exec');
const config = require('../config');
const gpg = require('../gpg');
const prompt = require('../prompt');

const SPEC = {
  out:             { },
  'include-store': { boolean: true },
};

async function exportRun(argv) {
  const { positional, opts } = parseArgs(argv, SPEC);
  if (positional.length > 0) usageError('zuul export takes no positional arguments');

  const cfg = config.requireInitialized();
  if (!fs.existsSync(cfg.passphraseFile)) {
    const err = new Error(`bot passphrase file missing: ${cfg.passphraseFile}`);
    err.exitCode = 1;
    throw err;
  }
  if (!await gpg.fingerprintExists(cfg.botKeyId)) {
    const err = new Error(`configured bot key ${cfg.botKeyId.slice(-16)} not in keyring`);
    err.exitCode = 1;
    throw err;
  }

  const includeStore = !!opts['include-store'];
  if (includeStore && !fs.existsSync(cfg.passwordStore)) {
    const err = new Error(`--include-store requested but ${cfg.passwordStore} does not exist`);
    err.exitCode = 1;
    throw err;
  }

  const outPath = path.resolve(opts.out || defaultOutPath());
  if (fs.existsSync(outPath)) {
    if (!await prompt.confirm(`overwrite ${outPath}?`, { defaultYes: false })) {
      process.stderr.write('aborted.\n');
      return;
    }
  }

  process.stderr.write('\nThis bundle will contain:\n');
  process.stderr.write(`  - bot key  (${cfg.botKeyId.slice(-16)})\n`);
  process.stderr.write(`  - bot passphrase  (${cfg.passphraseFile})\n`);
  if (includeStore) {
    process.stderr.write(`  - password store  (${cfg.passwordStore})\n`);
    process.stderr.write(`  - zuul config  (${config.configPath()})\n`);
  }
  process.stderr.write('\nIt will be encrypted with a passphrase you choose now.\n');
  process.stderr.write('You will need that passphrase to import on the destination machine.\n\n');

  const transitPass = await prompt.readPasswordConfirmed('Transit passphrase: ');
  if (!transitPass) {
    const err = new Error('refusing to write a bundle with an empty transit passphrase');
    err.exitCode = 64;
    throw err;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zuul-export-'));
  try {
    fs.chmodSync(work, 0o700);

    fs.writeFileSync(path.join(work, 'bot-key.asc'), await gpg.exportSecretKey(cfg.botKeyId), { mode: 0o600 });
    fs.copyFileSync(cfg.passphraseFile, path.join(work, 'bot-pass.txt'));
    fs.chmodSync(path.join(work, 'bot-pass.txt'), 0o600);

    const tarFiles = ['manifest.json', 'bot-key.asc', 'bot-pass.txt'];
    if (includeStore) {
      await run('cp', ['-R', cfg.passwordStore, path.join(work, 'password-store')]);
      fs.copyFileSync(config.configPath(), path.join(work, 'config.json'));
      fs.chmodSync(path.join(work, 'config.json'), 0o600);
      tarFiles.push('password-store', 'config.json');
    }

    const manifest = {
      version: 1,
      type: includeStore ? 'host-migration' : 'bot-key',
      botKeyId: cfg.botKeyId,
      humanKeyId: cfg.humanKeyId || null,
      namespace: cfg.namespace,
      exportedAt: new Date().toISOString(),
      exportedFrom: os.hostname(),
      includes: tarFiles.filter((f) => f !== 'manifest.json'),
    };
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

    const tarball = path.join(work, 'bundle.tgz');
    await run('tar', ['-czf', tarball, '-C', work, ...tarFiles]);

    process.stderr.write(`\nEncrypting bundle to ${outPath}...\n`);
    await gpg.symmetricEncrypt({ infile: tarball, outfile: outPath, passphrase: transitPass });
    fs.chmodSync(outPath, 0o600);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  process.stderr.write(`✓ wrote ${outPath} (mode 600)\n\n`);
  process.stderr.write('On the destination machine:\n');
  process.stderr.write(`  zuul import ${path.basename(outPath)}\n\n`);
  process.stderr.write('Wipe the bundle and any in-flight copies once import succeeds (e.g. shred -u).\n');
}

function defaultOutPath() {
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return path.resolve(process.cwd(), `zuul-export-${ts}.gpg`);
}

function usageError(msg) {
  const err = new Error(msg);
  err.exitCode = 64;
  throw err;
}

module.exports = { run: exportRun };
