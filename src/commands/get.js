const config = require('../config');
const pass = require('../pass');
const oath = require('../oath');
const { parseArgs } = require('../args');

const SPEC = {
  otp: { boolean: true, summary: "output a TOTP code from the entry's otp field" },
};

function usage() {
  process.stderr.write(
    'Usage: zuul get [--otp] <service>\n' +
    '\n' +
    'Without flags, prints the credential (line 1: password; subsequent lines: key: value).\n' +
    "With --otp, prints a freshly generated TOTP code from the entry's otp field.\n"
  );
}

async function run(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, SPEC);
  } catch (err) {
    usage();
    throw err;
  }

  const service = parsed.positional[0];
  if (!service || parsed.positional.length > 1) {
    usage();
    const err = new Error(service ? 'unexpected extra arguments' : 'missing service name');
    err.exitCode = 64;
    throw err;
  }

  const cfg = config.requireInitialized();
  const entry = `${cfg.namespace}/${service}`;

  let text;
  try {
    text = await pass.show({ passwordStore: cfg.passwordStore, entry });
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

  if (parsed.opts.otp) {
    const { fields } = pass.parseEntry(text);
    if (!fields.otp) {
      process.stderr.write(
        `zuul: credential '${service}' has no otp field.\n` +
        `Ask the user to add one by running:\n` +
        `  zuul add ${service} --otp <key>\n`
      );
      const e = new Error(`no otp field on entry: ${service}`);
      e.exitCode = 2;
      throw e;
    }
    const code = await oath.generate(fields.otp);
    process.stdout.write(code + '\n');
    return;
  }

  process.stdout.write(text + '\n');
}

module.exports = { run };
