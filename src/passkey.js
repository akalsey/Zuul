const crypto = require('node:crypto');

function validateBlob(value) {
  let parsed;
  try {
    const buf = Buffer.from(value, 'base64');
    parsed = JSON.parse(buf.toString());
  } catch {
    return { ok: false, message: 'passkey: not valid base64-encoded JSON' };
  }

  for (const field of ['credentialId', 'privateKey', 'rpId']) {
    if (!parsed[field] || typeof parsed[field] !== 'string') {
      return { ok: false, message: `passkey: missing required field '${field}'` };
    }
  }

  try {
    crypto.createPrivateKey({
      key: Buffer.from(parsed.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    return {
      ok: false,
      message: "passkey: privateKey is not valid PKCS#8 — check the blob came from gatepass passkey-register",
    };
  }

  return { ok: true, parsed };
}

function blobFromCredential(credential) {
  return Buffer.from(JSON.stringify(credential)).toString('base64');
}

module.exports = { validateBlob, blobFromCredential };
