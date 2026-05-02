const config = require('../config');
const pass = require('../pass');

async function run(args) {
  const service = args[0];
  if (!service) {
    process.stderr.write('zuul: usage: zuul get <service>\n');
    const err = new Error('missing service name');
    err.exitCode = 64;
    throw err;
  }

  const cfg = config.requireInitialized();
  const entry = `${cfg.namespace}/${service}`;

  try {
    const text = await pass.show({ passwordStore: cfg.passwordStore, entry });
    process.stdout.write(text + '\n');
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      process.stderr.write(
        `zuul: credential '${service}' is not stored.\n` +
        `Ask the user to add it by running:\n` +
        `  zuul add ${service}\n`
      );
      const e = new Error(`credential not found: ${service}`);
      e.exitCode = 2;
      throw e;
    }
    throw err;
  }
}

module.exports = { run };
