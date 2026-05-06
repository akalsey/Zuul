const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../args');
const config = require('../config');
const gpg = require('../gpg');
const prompt = require('../prompt');

const SPEC = {
  'as-bot':           { boolean: true },
  'as-personal':      { boolean: true },
  'passphrase-file':  { },
  'fingerprint':      { },
};

async function run(argv) {
  const { positional, opts } = parseArgs(argv, SPEC);

  if (positional.length !== 1) {
    usageError('zuul import-key <path-to-key-file> [--as-bot | --as-personal] [--passphrase-file FILE] [--fingerprint FPR]');
  }
  if (opts['as-bot'] && opts['as-personal']) {
    usageError('--as-bot and --as-personal are mutually exclusive');
  }

  const filepath = path.resolve(positional[0]);
  process.stderr.write(`Importing ${filepath} into the GPG keyring...\n`);
  const { added } = await gpg.importKeyFile(filepath);

  if (added.length === 0) {
    process.stderr.write('  (no new secret keys imported — they may already be in the keyring)\n');
    if (opts['as-bot'] || opts['as-personal']) {
      process.stderr.write('  pass --fingerprint <fpr> to select an existing key, or skip the role flag.\n');
    }
  } else {
    process.stderr.write(`  ✓ imported ${added.length} secret key(s):\n`);
    for (const k of added) {
      const uid = k.uids[0] || '(no uid)';
      process.stderr.write(`      ${k.fingerprint.slice(-16)}  ${uid}\n`);
    }
  }

  const isBot = !!opts['as-bot'];
  const isPersonal = !!opts['as-personal'];

  if (!isBot && !isPersonal) {
    printNextSteps();
    return;
  }

  const fingerprint = await pickFingerprint({
    explicit: opts['fingerprint'],
    candidates: added,
    role: isBot ? 'bot' : 'personal',
  });

  if (isBot) {
    await configureAsBot({ fingerprint, passphraseFileFlag: opts['passphrase-file'] });
  } else {
    await configureAsPersonal({ fingerprint });
  }
}

async function pickFingerprint({ explicit, candidates, role }) {
  if (explicit) {
    if (!await gpg.fingerprintExists(explicit)) {
      const err = new Error(`fingerprint not in keyring: ${explicit}`);
      err.exitCode = 1;
      throw err;
    }
    return explicit;
  }
  if (candidates.length === 1) return candidates[0].fingerprint;
  if (candidates.length === 0) {
    const err = new Error(`no newly-imported keys to assign as ${role}. Pass --fingerprint <fpr> to pick an existing key.`);
    err.exitCode = 1;
    throw err;
  }
  prompt.ensureTTY();
  process.stderr.write(`\nMultiple keys imported. Choose which one to use as the ${role} key:\n`);
  candidates.forEach((k, i) => {
    const uid = k.uids[0] || '(no uid)';
    process.stderr.write(`  [${i + 1}] ${k.fingerprint.slice(-16)}  ${uid}\n`);
  });
  const choice = await prompt.ask('Which key', { defaultValue: '1' });
  const idx = parseInt(choice, 10) - 1;
  if (idx < 0 || idx >= candidates.length) {
    const err = new Error('invalid choice');
    err.exitCode = 64;
    throw err;
  }
  return candidates[idx].fingerprint;
}

async function configureAsBot({ fingerprint, passphraseFileFlag }) {
  const cfg = config.load();

  if (cfg.botKeyId && cfg.botKeyId !== fingerprint) {
    process.stderr.write(`\n!! WARNING: a different bot key is already configured: ${cfg.botKeyId.slice(-16)}\n`);
    process.stderr.write('   Switching keys orphans any existing entries encrypted to the old bot key.\n');
    process.stderr.write('   You will need to re-init the password store and re-add credentials.\n');
    if (!await prompt.confirm('Replace the configured bot key anyway?', { defaultYes: false })) {
      process.stderr.write('aborted.\n');
      return;
    }
  }

  const passphrase = await collectBotPassphrase(passphraseFileFlag);
  const passphraseFile = cfg.passphraseFile;

  let backup = null;
  if (fs.existsSync(passphraseFile)) backup = fs.readFileSync(passphraseFile);

  fs.writeFileSync(passphraseFile, passphrase + '\n', { mode: 0o600 });
  process.stderr.write(`  ✓ wrote bot passphrase to ${passphraseFile} (chmod 600)\n`);

  await gpg.writeAgentConfig();

  try {
    await gpg.unlockBotKey({ fingerprint, passphraseFile });
  } catch (err) {
    if (backup !== null) fs.writeFileSync(passphraseFile, backup, { mode: 0o600 });
    else fs.unlinkSync(passphraseFile);
    const wrapped = new Error(`could not unlock bot key with the supplied passphrase: ${err.message}`);
    wrapped.exitCode = 1;
    throw wrapped;
  }
  process.stderr.write('  ✓ unlocked bot key in gpg-agent\n');

  config.save({ botKeyId: fingerprint, passphraseFile });
  process.stderr.write(`  ✓ saved bot key ${fingerprint.slice(-16)} to ${config.configPath()}\n`);

  if (!cfg.humanKeyId) {
    process.stderr.write('\nThis is an isolated bot-key import. To finish setup, run one of:\n');
    process.stderr.write('  zuul setup              # this machine has a personal key too\n');
    process.stderr.write('  zuul setup --bot-only   # this is a bot-only machine\n');
  } else {
    process.stderr.write('\nDone. Verify with: zuul doctor\n');
  }
}

async function collectBotPassphrase(passphraseFileFlag) {
  if (passphraseFileFlag) {
    const p = path.resolve(passphraseFileFlag);
    if (!fs.existsSync(p)) {
      const err = new Error(`passphrase file not found: ${p}`);
      err.exitCode = 64;
      throw err;
    }
    return fs.readFileSync(p, 'utf8').replace(/\r?\n+$/, '');
  }
  return await prompt.readPassword('Bot key passphrase: ');
}

async function configureAsPersonal({ fingerprint }) {
  const cfg = config.load();

  if (cfg.humanKeyId && cfg.humanKeyId !== fingerprint) {
    process.stderr.write(`\n!! WARNING: a different personal key is already configured: ${cfg.humanKeyId.slice(-16)}\n`);
    process.stderr.write('   Existing pass entries are encrypted to the old key. Switching keys means\n');
    process.stderr.write('   you must re-init pass with the new fingerprint and re-encrypt every entry:\n');
    process.stderr.write(`     pass init ${fingerprint}\n`);
    process.stderr.write(`     pass init --path ${cfg.namespace} ${cfg.botKeyId || '<bot-fpr>'} ${fingerprint}\n`);
    if (!await prompt.confirm('Update zuul config to point at the new personal key?', { defaultYes: false })) {
      process.stderr.write('aborted.\n');
      return;
    }
  }

  config.save({ humanKeyId: fingerprint });
  process.stderr.write(`  ✓ saved personal key ${fingerprint.slice(-16)} to ${config.configPath()}\n`);

  if (!cfg.botKeyId) {
    process.stderr.write('\nNo bot key configured yet. Finish setup with: zuul setup\n');
  } else if (cfg.humanKeyId && cfg.humanKeyId !== fingerprint) {
    process.stderr.write('\nDon\'t forget to re-init pass and re-encrypt your store (commands above).\n');
  } else {
    process.stderr.write('\nDone. Verify with: zuul doctor\n');
  }
}

function printNextSteps() {
  process.stderr.write([
    '',
    'Next steps:',
    '  zuul setup                            # if zuul has never been configured on this machine',
    '  zuul import-key <path> --as-bot       # to wire the imported key in as the bot key',
    '  zuul import-key <path> --as-personal  # to wire it in as your personal key',
    '',
  ].join('\n'));
}

function usageError(msg) {
  const err = new Error(msg);
  err.exitCode = 64;
  throw err;
}

module.exports = { run };
