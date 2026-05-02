const config = require('../config');
const gpg = require('../gpg');

async function run() {
  const cfg = config.requireInitialized();
  await gpg.unlockBotKey({
    fingerprint: cfg.botKeyId,
    passphraseFile: cfg.passphraseFile,
  });
  process.stderr.write('zuul: bot key unlocked\n');
}

module.exports = { run };
