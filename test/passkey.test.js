const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateBlob, blobFromCredential } = require('../src/passkey');

// Generate a real PKCS#8 EC key for use in tests
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const validPrivateKeyB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

function makeBlob(overrides = {}) {
  const obj = {
    credentialId: Buffer.from('testcredid').toString('base64'),
    privateKey: validPrivateKeyB64,
    rpId: 'example.com',
    userHandle: Buffer.from('user1').toString('base64'),
    signCount: 0,
    isResidentCredential: true,
    ...overrides,
  };
  return blobFromCredential(obj);
}

test('validateBlob: valid blob returns ok', () => {
  const result = validateBlob(makeBlob());
  assert.equal(result.ok, true);
  assert.equal(result.parsed.rpId, 'example.com');
});

test('validateBlob: not base64 JSON returns error', () => {
  const result = validateBlob('not-valid-base64!!!');
  assert.equal(result.ok, false);
  assert.match(result.message, /not valid base64-encoded JSON/);
});

test('validateBlob: valid base64 but not JSON returns error', () => {
  const result = validateBlob(Buffer.from('hello world').toString('base64'));
  assert.equal(result.ok, false);
  assert.match(result.message, /not valid base64-encoded JSON/);
});

test('validateBlob: missing credentialId returns error', () => {
  const result = validateBlob(makeBlob({ credentialId: undefined }));
  assert.equal(result.ok, false);
  assert.match(result.message, /missing required field 'credentialId'/);
});

test('validateBlob: missing privateKey returns error', () => {
  const result = validateBlob(makeBlob({ privateKey: undefined }));
  assert.equal(result.ok, false);
  assert.match(result.message, /missing required field 'privateKey'/);
});

test('validateBlob: missing rpId returns error', () => {
  const result = validateBlob(makeBlob({ rpId: undefined }));
  assert.equal(result.ok, false);
  assert.match(result.message, /missing required field 'rpId'/);
});

test('validateBlob: invalid PKCS#8 key returns error', () => {
  const result = validateBlob(makeBlob({ privateKey: Buffer.from('notakey').toString('base64') }));
  assert.equal(result.ok, false);
  assert.match(result.message, /not valid PKCS#8/);
});

test('blobFromCredential: round-trips through validateBlob', () => {
  const credential = {
    credentialId: Buffer.from('testcredid').toString('base64'),
    privateKey: validPrivateKeyB64,
    rpId: 'example.com',
    userHandle: Buffer.from('user1').toString('base64'),
    signCount: 0,
    isResidentCredential: true,
  };
  const blob = blobFromCredential(credential);
  const result = validateBlob(blob);
  assert.equal(result.ok, true);
  assert.equal(result.parsed.rpId, 'example.com');
});
