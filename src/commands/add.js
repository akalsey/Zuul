const config = require('../config');
const pass = require('../pass');
const prompt = require('../prompt');

async function run(args) {
  const service = args[0];
  if (!service) {
    process.stderr.write('zuul: usage: zuul add <service>\n');
    const err = new Error('missing service name');
    err.exitCode = 64;
    throw err;
  }

  prompt.ensureTTY();
  const cfg = config.requireInitialized();
  const entry = `${cfg.namespace}/${service}`;

  if (pass.entryExists(cfg.passwordStore, entry)) {
    const ok = await prompt.confirm(`'${entry}' already exists. Overwrite?`);
    if (!ok) {
      process.stderr.write('aborted.\n');
      return;
    }
  }

  process.stderr.write(`Adding credential: ${entry}\n`);
  process.stderr.write(`(encrypted to bot key + your key)\n\n`);

  const password = await prompt.readPasswordConfirmed('Password: ');
  if (!password) {
    const err = new Error('password cannot be empty');
    err.exitCode = 1;
    throw err;
  }

  const username = await prompt.ask('Username (optional)');
  const url = await prompt.ask('URL (optional)');
  const extras = await prompt.readMultilineFields();

  const lines = [password];
  if (username) lines.push(`username: ${username}`);
  if (url) lines.push(`url: ${url}`);
  lines.push(...extras);

  await pass.insert({
    passwordStore: cfg.passwordStore,
    entry,
    content: lines.join('\n'),
  });

  process.stderr.write(`\nStored. The agent can now retrieve it with:\n  zuul get ${service}\n`);
}

module.exports = { run };
