const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const gpg = require('../gpg');
const pass = require('../pass');
const prompt = require('../prompt');
const { run } = require('../exec');

async function setupRun() {
  prompt.ensureTTY();

  process.stderr.write([
    '',
    '  zuul setup',
    '  ----------',
    '  This wizard configures secret storage for an OpenClaw agent.',
    '  It will:',
    '    - check that gpg and pass are installed',
    '    - generate a bot GPG key (or reuse an existing one)',
    '    - select your personal GPG key (or generate one)',
    '    - configure gpg-agent for unattended use',
    '    - initialize the password store with a bot-readable namespace',
    '    - store the bot passphrase in ~/.bot-pass.txt (chmod 600)',
    '    - run a test insert + retrieve to verify everything works',
    '',
  ].join('\n'));

  if (!await prompt.confirm('Proceed?', { defaultYes: true })) {
    process.stderr.write('aborted.\n');
    return;
  }

  await checkTools();
  const cfg = config.load();

  const namespace = await prompt.ask('Namespace for bot-readable secrets', { defaultValue: cfg.namespace });

  const humanKey = await pickHumanKey();
  const botKey = await ensureBotKey({ existingFingerprint: cfg.botKeyId, humanFingerprint: humanKey });

  await gpg.writeAgentConfig();
  process.stderr.write('  ✓ wrote ~/.gnupg/gpg.conf and gpg-agent.conf (loopback pinentry, long cache TTL)\n');

  await initPasswordStore({
    passwordStore: cfg.passwordStore,
    namespace,
    humanFingerprint: humanKey,
    botFingerprint: botKey.fingerprint,
  });
  process.stderr.write(`  ✓ initialized password store at ${cfg.passwordStore}\n`);
  process.stderr.write(`  ✓ namespace '${namespace}/' is encrypted to bot key + your key\n`);

  config.save({
    namespace,
    botKeyId: botKey.fingerprint,
    humanKeyId: humanKey,
    passphraseFile: botKey.passphraseFile,
    passwordStore: cfg.passwordStore,
  });
  process.stderr.write(`  ✓ saved config to ${config.configPath()}\n`);

  await gpg.unlockBotKey({ fingerprint: botKey.fingerprint, passphraseFile: botKey.passphraseFile });
  process.stderr.write('  ✓ unlocked bot key in gpg-agent\n');

  await verify({ passwordStore: cfg.passwordStore, namespace });
  process.stderr.write('  ✓ verified end-to-end (test secret inserted, retrieved, removed)\n');

  await offerBootUnlock({ fingerprint: botKey.fingerprint, passphraseFile: botKey.passphraseFile });

  process.stderr.write([
    '',
    'Setup complete.',
    '',
    'Next steps:',
    `  zuul add metabase           # store your first credential`,
    `  zuul get metabase           # the agent retrieves it`,
    `  zuul doctor                 # diagnose any issues`,
    '',
  ].join('\n'));
}

async function checkTools() {
  if (!await gpg.isInstalled()) {
    throw withInstall('gpg is not installed.', {
      darwin: 'brew install gnupg',
      linux: 'apt install gnupg     # or: dnf install gnupg2',
    });
  }
  process.stderr.write('  ✓ gpg installed\n');

  if (!await pass.isInstalled()) {
    throw withInstall('pass is not installed.', {
      darwin: 'brew install pass',
      linux: 'apt install pass     # or: dnf install pass',
    });
  }
  process.stderr.write('  ✓ pass installed\n');
}

function withInstall(msg, hints) {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const err = new Error(`${msg} Install with: ${hints[platform]}`);
  err.exitCode = 5;
  return err;
}

async function pickHumanKey() {
  const keys = await gpg.listSecretKeys();
  if (keys.length === 0) {
    process.stderr.write('\nNo GPG secret keys found. Generating a personal key for you.\n');
    return await generatePersonalKey();
  }

  process.stderr.write('\nExisting GPG secret keys:\n');
  keys.forEach((k, i) => {
    const uid = k.uids[0] || '(no uid)';
    process.stderr.write(`  [${i + 1}] ${k.fingerprint.slice(-16)}  ${uid}\n`);
  });
  process.stderr.write('  [n] generate a new personal key\n\n');
  const choice = await prompt.ask('Choose your personal key', { defaultValue: '1' });
  if (choice === 'n') return await generatePersonalKey();
  const idx = parseInt(choice, 10) - 1;
  if (idx >= 0 && idx < keys.length) {
    process.stderr.write(`  ✓ using ${keys[idx].fingerprint.slice(-16)}\n`);
    return keys[idx].fingerprint;
  }
  process.stderr.write('invalid choice.\n');
  return await pickHumanKey();
}

async function generatePersonalKey() {
  const name = await prompt.ask('Your name');
  const email = await prompt.ask('Your email');
  process.stderr.write('Generating personal key... (this may take 30-60 seconds)\n');
  const fpr = await gpg.generateKey({ name, email, passphrase: null });
  process.stderr.write(`  ✓ created personal key ${fpr.slice(-16)}\n`);
  process.stderr.write('  (no passphrase set — protect this key with disk encryption)\n');
  return fpr;
}

async function ensureBotKey({ existingFingerprint, humanFingerprint }) {
  const cfg = config.load();

  if (existingFingerprint && await gpg.fingerprintExists(existingFingerprint)) {
    if (fs.existsSync(cfg.passphraseFile)) {
      process.stderr.write(`  ✓ reusing existing bot key ${existingFingerprint.slice(-16)}\n`);
      return { fingerprint: existingFingerprint, passphraseFile: cfg.passphraseFile };
    }
    process.stderr.write(`\n  Configured bot key ${existingFingerprint.slice(-16)} is in your keyring,\n`);
    process.stderr.write(`  but its passphrase file ${cfg.passphraseFile} is missing.\n`);
    return await reuseBotKey({ fingerprint: existingFingerprint, passphraseFile: cfg.passphraseFile });
  }

  const candidates = (await gpg.listSecretKeys()).filter((k) => k.fingerprint !== humanFingerprint);
  if (candidates.length > 0) {
    process.stderr.write('\nExisting GPG secret keys you can use as the bot key:\n');
    candidates.forEach((k, i) => {
      const uid = k.uids[0] || '(no uid)';
      process.stderr.write(`  [${i + 1}] ${k.fingerprint.slice(-16)}  ${uid}\n`);
    });
    process.stderr.write('  [n] generate a new bot key\n\n');
    const choice = await prompt.ask('Choose bot key', { defaultValue: 'n' });
    if (choice !== 'n') {
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < candidates.length) {
        return await reuseBotKey({ fingerprint: candidates[idx].fingerprint, passphraseFile: cfg.passphraseFile });
      }
      process.stderr.write('  invalid choice — generating a new bot key.\n');
    }
  }

  return await generateNewBotKey({ passphraseFile: cfg.passphraseFile });
}

async function reuseBotKey({ fingerprint, passphraseFile }) {
  process.stderr.write(`  reusing bot key ${fingerprint.slice(-16)} — verifying its passphrase.\n`);
  await gpg.writeAgentConfig();

  const backup = fs.existsSync(passphraseFile) ? fs.readFileSync(passphraseFile) : null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const passphrase = await prompt.readPassword(`Bot key passphrase (attempt ${attempt}/3): `);
    fs.writeFileSync(passphraseFile, passphrase + '\n', { mode: 0o600 });
    try {
      await gpg.unlockBotKey({ fingerprint, passphraseFile });
      process.stderr.write(`  ✓ verified passphrase, wrote to ${passphraseFile} (chmod 600)\n`);
      return { fingerprint, passphraseFile };
    } catch {
      process.stderr.write('  ✗ that passphrase did not unlock the key.\n');
    }
  }

  if (backup !== null) fs.writeFileSync(passphraseFile, backup, { mode: 0o600 });
  else if (fs.existsSync(passphraseFile)) fs.unlinkSync(passphraseFile);
  const err = new Error('failed to verify bot key passphrase after 3 attempts');
  err.exitCode = 1;
  throw err;
}

async function generateNewBotKey({ passphraseFile }) {
  const passphrase = gpg.generatePassphrase();
  fs.writeFileSync(passphraseFile, passphrase + '\n', { mode: 0o600 });
  process.stderr.write(`  ✓ wrote bot passphrase to ${passphraseFile} (chmod 600)\n`);

  process.stderr.write('Generating bot key... (this may take 30-60 seconds)\n');
  const fingerprint = await gpg.generateKey({
    name: 'Zuul Bot',
    email: `zuul-bot@${os.hostname()}`,
    comment: 'OpenClaw secret retrieval',
    passphrase,
  });
  process.stderr.write(`  ✓ created bot key ${fingerprint.slice(-16)}\n`);

  return { fingerprint, passphraseFile };
}

async function initPasswordStore({ passwordStore, namespace, humanFingerprint, botFingerprint }) {
  fs.mkdirSync(passwordStore, { recursive: true, mode: 0o700 });
  await pass.initRecipients({ passwordStore, recipients: [humanFingerprint] });
  await pass.initRecipients({ passwordStore, subdir: namespace, recipients: [botFingerprint, humanFingerprint] });
}

async function verify({ passwordStore, namespace }) {
  const testEntry = `${namespace}/__zuul-selftest__`;
  const probe = `selftest-${Date.now()}`;
  await pass.insert({ passwordStore, entry: testEntry, content: probe });
  const got = await pass.show({ passwordStore, entry: testEntry });
  await pass.remove({ passwordStore, entry: testEntry });
  if (got.trim() !== probe) {
    throw new Error('self-test failed: retrieved value did not match');
  }
}

async function offerBootUnlock({ fingerprint, passphraseFile }) {
  process.stderr.write('\n');
  if (process.platform === 'darwin') {
    return await offerLaunchd({ fingerprint, passphraseFile });
  }
  if (process.platform === 'linux') {
    return await offerSystemd({ fingerprint, passphraseFile });
  }
  process.stderr.write('Boot-time unlock is not automated for your platform. Run `zuul unlock` at session start.\n');
}

async function offerLaunchd({ fingerprint, passphraseFile }) {
  const label = 'ai.openclaw.zuul-unlock';
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const zuulBin = process.execPath; // node binary
  const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'zuul.js');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${zuulBin}</string>
    <string>${cliPath}</string>
    <string>unlock</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key><string>/tmp/${label}.log</string>
</dict>
</plist>
`;

  process.stderr.write(`Boot-time unlock: install a launchd agent at ${plistPath}?\n`);
  process.stderr.write('  (this runs `zuul unlock` automatically at every login so the agent runtime needs no human)\n');
  if (!await prompt.confirm('Install?', { defaultYes: true })) {
    process.stderr.write('  skipped. Run `zuul unlock` manually at session start.\n');
    return;
  }
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  try {
    await run('launchctl', ['unload', plistPath]).catch(() => {});
    await run('launchctl', ['load', plistPath]);
    process.stderr.write(`  ✓ installed and loaded ${plistPath}\n`);
    config.save({ bootUnlockInstalled: true });
  } catch (err) {
    process.stderr.write(`  wrote ${plistPath} but failed to load it: ${err.message}\n`);
    process.stderr.write(`  load it manually with: launchctl load ${plistPath}\n`);
  }
}

async function offerSystemd({ fingerprint, passphraseFile }) {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'zuul-unlock.service');
  const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'zuul.js');

  const unit = `[Unit]
Description=Unlock zuul bot key in gpg-agent
After=default.target

[Service]
Type=oneshot
ExecStart=${process.execPath} ${cliPath} unlock
RemainAfterExit=yes

[Install]
WantedBy=default.target
`;

  process.stderr.write(`Boot-time unlock: install a systemd user service at ${unitPath}?\n`);
  process.stderr.write('  (this runs `zuul unlock` automatically at every login so the agent runtime needs no human)\n');
  if (!await prompt.confirm('Install?', { defaultYes: true })) {
    process.stderr.write('  skipped. Run `zuul unlock` manually at session start.\n');
    return;
  }
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(unitPath, unit);
  try {
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', 'zuul-unlock.service']);
    process.stderr.write(`  ✓ installed and enabled zuul-unlock.service\n`);
    config.save({ bootUnlockInstalled: true });
  } catch (err) {
    process.stderr.write(`  wrote ${unitPath} but failed to enable it: ${err.message}\n`);
    process.stderr.write(`  enable it manually with: systemctl --user enable --now zuul-unlock.service\n`);
  }
}

module.exports = { run: setupRun };
