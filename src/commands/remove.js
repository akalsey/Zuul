const config = require('../config');
const pass = require('../pass');
const prompt = require('../prompt');

async function run(args) {
  const service = args[0];
  if (!service) {
    process.stderr.write('zuul: usage: zuul remove <service>\n');
    const err = new Error('missing service name');
    err.exitCode = 64;
    throw err;
  }

  prompt.ensureTTY();
  const cfg = config.requireInitialized();
  const entry = `${cfg.namespace}/${service}`;

  if (!pass.entryExists(cfg.passwordStore, entry)) {
    process.stderr.write(`zuul: '${entry}' is not stored.\n`);
    const err = new Error('not found');
    err.exitCode = 2;
    throw err;
  }

  const ok = await prompt.confirm(`Remove '${entry}'?`);
  if (!ok) {
    process.stderr.write('aborted.\n');
    return;
  }

  await pass.remove({ passwordStore: cfg.passwordStore, entry });
  process.stderr.write(`removed: ${entry}\n`);
}

module.exports = { run };
