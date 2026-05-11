const config = require('../config');
const pass = require('../pass');
const prompt = require('../prompt');
const oath = require('../oath');
const { parseArgs } = require('../args');
const { validateBlob } = require('../passkey');

const SPEC = {
  user:    { short: 'u', summary: 'username / login' },
  url:     {              summary: 'service URL' },
  email:   {              summary: 'email address (when distinct from user)' },
  otp:     {              summary: 'TOTP secret (otpauth:// URI or base32)' },
  note:    {              summary: 'free-form note' },
  passkey: {              summary: 'WebAuthn credential blob (base64 JSON, from zuul passkey-register)' },
  field:   { short: 'F', repeatable: true, summary: 'extra field as key=value (repeatable)' },
};

const FIELD_KEY_RE = /^[a-z][a-z0-9-]*$/;

function usage() {
  process.stderr.write(
    'Usage: zuul add <service> [flags]\n' +
    '\n' +
    'Stores a credential in the bot-readable namespace. The password is\n' +
    'always prompted (hidden, with confirmation). All other fields can be\n' +
    'supplied via flags or entered interactively.\n' +
    '\n' +
    'Flags:\n' +
    Object.entries(SPEC).map(([name, def]) => {
      const left = (def.short ? `-${def.short}, ` : '    ') + `--${name}`.padEnd(10);
      return `  ${left}  ${def.summary}`;
    }).join('\n') + '\n'
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

  const fields = collectFlagFields(parsed.opts);

  process.stderr.write(`\nAdding credential: ${entry}\n`);
  process.stderr.write(
    cfg.humanKeyId
      ? `(encrypted to bot key + your key)\n\n`
      : `(encrypted to bot key only)\n\n`
  );

  const password = await prompt.readPasswordConfirmed('Password: ');
  if (!password) {
    const err = new Error('password cannot be empty');
    err.exitCode = 1;
    throw err;
  }

  if (!fields.user) {
    const v = await prompt.ask('User (optional)');
    if (v) fields.user = v;
  }
  if (!fields.url) {
    const v = await prompt.ask('URL (optional)');
    if (v) fields.url = v;
  }
  if (!fields.otp) {
    const v = await prompt.ask('One time password key — otpauth:// URI or base32 (optional)');
    if (v) fields.otp = v;
  }

  if (fields.otp && !await verifyOtp(fields.otp)) {
    process.stderr.write('aborted — credential not saved.\n');
    return;
  }

  if (!fields.passkey) {
    const v = await prompt.ask('Passkey credential blob (base64 JSON, from zuul passkey-register) (optional)');
    if (v) fields.passkey = v;
  }

  if (fields.passkey) {
    const check = validateBlob(fields.passkey);
    if (!check.ok) {
      process.stderr.write(`\n${check.message}\n`);
      process.stderr.write('aborted — credential not saved.\n');
      return;
    }
  }

  const extras = await prompt.readMultilineFields();
  for (const line of extras) {
    const m = line.match(/^([^:\s][^:]*):\s*(.+)$/);
    if (m) {
      const key = m[1].trim().toLowerCase();
      if (!FIELD_KEY_RE.test(key)) {
        process.stderr.write(`  (skipped '${key}' — keys must be lowercase letters, digits, dashes)\n`);
        continue;
      }
      fields[key] = m[2].trim();
    }
  }

  const content = pass.formatEntry({ password, fields });
  await pass.insert({ passwordStore: cfg.passwordStore, entry, content });

  process.stderr.write(`\nStored. The agent can now retrieve it with:\n  zuul get ${service}\n`);
}

async function verifyOtp(otpKey) {
  let code;
  try {
    code = await oath.generate(otpKey);
  } catch (err) {
    process.stderr.write(`\nCould not generate a TOTP code: ${err.message}\n`);
    return false;
  }
  process.stderr.write(`\nTOTP code: ${code}\n`);
  process.stderr.write(
    'Enter this code in the service to confirm OTP setup. Most services\n' +
    'require a working code before they will enable OTP on the account.\n\n'
  );
  return await prompt.confirm('Did the code work?', { defaultYes: true });
}

function collectFlagFields(opts) {
  const fields = {};
  for (const k of ['user', 'url', 'email', 'otp', 'note', 'passkey']) {
    if (opts[k]) fields[k] = opts[k];
  }
  for (const item of opts.field) {
    const eq = item.indexOf('=');
    if (eq <= 0) {
      const err = new Error(`--field expects key=value, got: ${item}`);
      err.exitCode = 64;
      throw err;
    }
    const key = item.slice(0, eq).trim().toLowerCase();
    const val = item.slice(eq + 1).trim();
    if (!FIELD_KEY_RE.test(key)) {
      const err = new Error(`invalid field key '${key}' — must be lowercase letters, digits, dashes`);
      err.exitCode = 64;
      throw err;
    }
    if (!val) {
      const err = new Error(`--field ${key} has empty value`);
      err.exitCode = 64;
      throw err;
    }
    fields[key] = val;
  }
  return fields;
}

module.exports = { run };
