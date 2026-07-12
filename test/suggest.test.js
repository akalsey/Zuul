const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nearest } = require('../src/suggest');

const STORED = ['github', 'google', 'google-mcp', 'posthog'];

test('nearest: over-specific guess matches the stored prefix', () => {
  assert.equal(nearest('posthog-api-key', STORED), 'posthog');
});

test('nearest: single-character typo matches', () => {
  assert.equal(nearest('guthub', STORED), 'github');
});

test('nearest: exact-but-longer suffix guess matches', () => {
  assert.equal(nearest('github-token', STORED), 'github');
});

test('nearest: prefers the more specific containment match', () => {
  assert.equal(nearest('google-mcp-key', STORED), 'google-mcp');
});

test('nearest: unrelated name returns null', () => {
  assert.equal(nearest('stripe', STORED), null);
});

test('nearest: empty candidate list returns null', () => {
  assert.equal(nearest('github', []), null);
});

test('nearest: exact match is not offered as a suggestion', () => {
  assert.equal(nearest('github', STORED), null);
});

test('nearest: matching is case-insensitive', () => {
  assert.equal(nearest('GitHub', STORED), 'github');
});

test('nearest: short unrelated target does not spuriously match', () => {
  assert.equal(nearest('s3', STORED), null);
});
