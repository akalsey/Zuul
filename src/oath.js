const { run, which, ExecError } = require('./exec');

const SUPPORTED_HASHES = new Set(['sha1', 'sha256', 'sha512']);

async function isInstalled() {
  return (await which('oathtool')) !== null;
}

function parseOtpKey(input) {
  const raw = (input || '').trim();
  if (!raw) {
    const err = new Error('otp key is empty');
    err.exitCode = 1;
    throw err;
  }

  if (/^otpauth:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      const err = new Error(`invalid otpauth URI: ${e.message}`);
      err.exitCode = 1;
      throw err;
    }
    if (parsed.hostname.toLowerCase() !== 'totp') {
      const err = new Error(`only otpauth://totp/ URIs are supported (got '${parsed.hostname}')`);
      err.exitCode = 1;
      throw err;
    }
    const secret = parsed.searchParams.get('secret');
    if (!secret) {
      const err = new Error('otpauth URI is missing the secret parameter');
      err.exitCode = 1;
      throw err;
    }
    const hash = (parsed.searchParams.get('algorithm') || '').toLowerCase() || null;
    if (hash && !SUPPORTED_HASHES.has(hash)) {
      const err = new Error(`unsupported algorithm: ${hash}`);
      err.exitCode = 1;
      throw err;
    }
    return {
      secret: secret.trim(),
      digits: parsed.searchParams.get('digits') || null,
      algorithm: hash,
      period: parsed.searchParams.get('period') || null,
    };
  }

  return { secret: raw.replace(/\s+/g, ''), digits: null, algorithm: null, period: null };
}

async function generate(input) {
  if (!await isInstalled()) {
    const err = new Error(
      'oathtool is not installed. Install with: brew install oath-toolkit (macOS) ' +
      'or apt install oathtool (Debian/Ubuntu) or dnf install oathtool (Fedora/RHEL).'
    );
    err.exitCode = 5;
    throw err;
  }

  const { secret, digits, algorithm, period } = parseOtpKey(input);
  const args = [algorithm ? `--totp=${algorithm}` : '--totp', '-b'];
  if (digits) args.push('-d', digits);
  if (period) args.push('-s', period);
  args.push(secret);

  try {
    const { stdout } = await run('oathtool', args);
    const code = stdout.trim();
    if (!code) {
      const err = new Error('oathtool returned no code');
      err.exitCode = 1;
      throw err;
    }
    return code;
  } catch (err) {
    if (err instanceof ExecError) {
      const detail = (err.stderr || err.stdout || '').trim() || err.message;
      const e = new Error(`oathtool failed: ${detail}`);
      e.exitCode = 1;
      throw e;
    }
    throw err;
  }
}

module.exports = { isInstalled, parseOtpKey, generate };
