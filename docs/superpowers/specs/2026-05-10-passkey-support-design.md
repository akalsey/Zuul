# Passkey Support Design

**Date:** 2026-05-10
**Status:** Approved

## Overview

Add passkey (WebAuthn) credential support to Zuul. Bots with browser access can use virtual authenticators to sign in with passkeys; this feature gives them a way to store and retrieve the necessary credential material through the existing `zuul get` / `zuul add` interface.

## Background

Passkeys are WebAuthn credentials: a private key held by an authenticator that signs challenges from the relying party. Unlike TOTP, the credential bytes themselves are directly usable by browser automation tools — no transformation step is needed. This means passkeys fit the existing `zuul get` output model (return the field value, let the agent use it) rather than the `--otp` model (zuul transforms the value before returning it).

1Password cannot currently export passkeys. Bitwarden and Dashlane can, but import support is deferred until it can be tested. The only registration path for now is `zuul passkey-register`.

## Storage Format

`passkey` joins the opinionated field set alongside `user`, `url`, `email`, `otp`, and `note`.

Its value is a base64-encoded JSON blob using the Playwright CDP `WebAuthn.getCredentials` schema as the canonical representation:

```json
{
  "credentialId": "<base64>",
  "privateKey": "<base64, PKCS#8 DER>",
  "rpId": "github.com",
  "userHandle": "<base64>",
  "signCount": 0,
  "isResidentCredential": true
}
```

Example pass entry:

```
s3cr3tpassword
url: https://github.com
user: alice@example.com
passkey: eyJjcmVkZW50aWFsSWQiOiJB...
```

The password line is unchanged — it may be populated or empty. A service can have both a password and a passkey registered. The bot uses the passkey for login; the password is preserved for human use.

Required fields in the blob: `credentialId`, `privateKey`, `rpId`. Optional: `userHandle`, `signCount`, `isResidentCredential`.

## Changes to `zuul add`

`passkey` is added to the flag spec and interactive prompt sequence, parallel to `--otp`.

**`SPEC` update:** Add `passkey` to the `SPEC` object in `add.js` alongside the existing named fields:
```js
passkey: { summary: 'WebAuthn credential blob (base64 JSON, from zuul passkey-register)' },
```
Without this, `parseArgs` rejects `--passkey` before `collectFlagFields` is reached.

**`collectFlagFields` update:** Add `'passkey'` to the hardcoded field list in `collectFlagFields` alongside `'user', 'url', 'email', 'otp', 'note'` so the flag value is transferred into `fields`.

**Interactive prompt position:** A `if (!fields.passkey)` block is added to `run()` following the same pattern as the existing `if (!fields.user)`, `if (!fields.url)`, and `if (!fields.otp)` blocks. It is inserted after the OTP verify step and before the multiline fields prompt:
```
user → url → otp → [OTP verify] → passkey → [passkey validate] → multiline fields
```
Passkey validation runs immediately after the prompt (abort if invalid, same as OTP).

**Validation on input:** Before saving, `zuul add` must:
1. Base64-decode the raw string value into a Buffer: `const buf = Buffer.from(value, 'base64')`
2. Parse as JSON: `const parsed = JSON.parse(buf.toString())` — if this throws, fail
3. Verify `parsed.credentialId`, `parsed.privateKey`, and `parsed.rpId` are present and non-empty strings
4. Parse the private key: `crypto.createPrivateKey({ key: Buffer.from(parsed.privateKey, 'base64'), format: 'der', type: 'pkcs8' })` — if this throws, the key is invalid

Error messages:
- Decode/parse failure: `"passkey: not valid base64-encoded JSON"`
- Missing required field: `"passkey: missing required field '<field>'"`
- Invalid private key: `"passkey: privateKey is not valid PKCS#8 — check the blob came from zuul passkey-register"`

If any validation fails, print the error to stderr and abort without saving. This mirrors how `--otp` confirms the TOTP key works before saving.

## New Command: `zuul passkey-register <service>`

Registers a fresh passkey with a service using a Playwright virtual authenticator, extracts the credential, and outputs the `zuul add` command for the human to run.

**CLI dispatcher:** `passkey-register` is added to the `COMMANDS` map in `cli.js` following the existing `'import-key'` precedent for hyphenated command names. No dispatcher changes are needed beyond the new entry.

**Playwright dependency:** Playwright is not added to Zuul's core dependencies. At runtime, `zuul passkey-register` checks for Playwright using `require.resolve('playwright')` wrapped in a try/catch. If not installed:
- Prompt: `Playwright is required for passkey registration. Install it now?`
- If yes: resolve Zuul's package root as `const zuulPkgDir = path.join(__dirname, '..', '..')` (from `src/commands/passkey-register.js`, `../..` is the package root — correct for both local and global installs since `__dirname` is always within the package). Run `npm install --prefix <zuulPkgDir> playwright` using `exec.js` `run()` with `{ capture: false }` so output streams live to the terminal — `npm install` takes several seconds and must not appear frozen. If the command exits non-zero, print `"Playwright install failed. Try manually: npm install --prefix <zuulPkgDir> playwright"` and exit with code 5.
- After install, use `require.resolve('playwright', { paths: [zuulPkgDir] })` to confirm it succeeded before proceeding. This form explicitly scopes resolution to Zuul's package tree rather than the caller's working directory.
- If no, or if install fails: print `Install manually with: npm install --prefix <zuulPkgDir> playwright` (with the resolved path) and exit with code 5.

**Registration flow:**
1. Human runs: `zuul passkey-register github`
2. Command looks up the stored `url` field by calling `pass.show({ passwordStore: cfg.passwordStore, entry })` then `pass.parseEntry(text)` directly (the same internal API used by `get.js`) — do not spawn a `zuul get` child process. If the entry does not exist or has no `url` field, prompt: `Service URL for passkey registration:` using `prompt.ask`. If the human enters a value that does not start with `http://` or `https://`, print `"invalid URL — must start with https://"` and re-prompt (up to 3 times, then exit with code 1).
3. Opens a Playwright browser window (non-headless so the human can interact)
4. Creates a CDP session and calls `WebAuthn.enable` then `WebAuthn.addVirtualAuthenticator` with `{ protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true }`. If either CDP call throws, print: `"Could not inject virtual authenticator — ensure your Playwright version supports CDP WebAuthn (requires Chromium). Error: <message>"` and exit with code 1.
5. Navigates to the service URL and prints: `Complete passkey registration in the browser window. Press Ctrl+C to cancel.`
6. Listens for the `WebAuthn.credentialAdded` CDP event with a **120-second timeout**. If the timeout fires before the event, print: `"Timed out waiting for passkey registration (120s). The browser window will stay open — run zuul passkey-register again if you want to retry."` then close the browser and exit with code 1.
7. On event receipt, use the `credential` field from the `WebAuthn.credentialAdded` event payload directly — do not make a separate `WebAuthn.getCredentials` call. The event payload key is `credential` (singular object), not `credentials` (the plural array returned by `getCredentials`). Serialize `event.credential` to JSON and base64-encode it.
8. Validate the blob using the same steps as `zuul add` (base64-decode → JSON parse → required fields → `crypto.createPrivateKey`). If validation fails, print the error, close the browser, and exit with code 1.
9. Close the browser.
10. If an entry for `<service>` already exists: call `pass.show` + `pass.parseEntry` to load it, set `fields.passkey = blob`, reserialize with `pass.formatEntry`, and write back with `pass.insert`. This preserves all existing fields (password, url, user, etc.) and only adds or replaces the `passkey:` field.
11. If no entry exists: create a new one with an empty password line and `passkey:` as the only field, using `pass.formatEntry` + `pass.insert`.
12. Print: `Passkey stored. The agent can now authenticate to ${service} with: zuul get ${service}`

## Changes to `zuul get`

No changes. `zuul get <service>` returns the `passkey:` field like any other field. No `--passkey` flag is needed because the stored value is directly usable by the agent — contrast with `--otp`, which requires zuul to call `oathtool` to transform the TOTP secret into a current code.

## Agent Skill Updates

### `skills/secrets-management/SKILL.md`

Add `passkey` to the standard fields table:

| Field | Meaning |
|---|---|
| `passkey` | WebAuthn credential blob (base64 JSON). When present, use passkey authentication — do not type a password. Decode and load into your browser automation tool's virtual authenticator before navigating to the login page. |

Add rule:

> If the output contains a `passkey:` field, authenticate using the passkey credential rather than the password. The value is a base64-encoded JSON blob containing the WebAuthn credential. The password field may also be present but should be ignored for login.

### New: `docs/passkey-automation.md`

A practical guide with code examples. Required content:

1. **Decode the blob** — one-liner showing `JSON.parse(Buffer.from(blob, 'base64').toString())`
2. **Playwright example** — complete snippet: create CDP session, `WebAuthn.enable`, `WebAuthn.addVirtualAuthenticator`, `WebAuthn.addCredential` (mapping field names from the blob), navigate, call `page.context().browser()` passkey flow
3. **Puppeteer example** — equivalent using Puppeteer's CDP session API
4. **Selenium example** — equivalent using the `webdriver.bidi` or CDP approach for Chromium-based drivers; note that Selenium WebAuthn support is more limited
5. **Field mapping table** — Zuul blob field → CDP `addCredential` parameter name (they differ slightly between tools)
6. **Sign count note** — explain that `signCount` in the stored blob will become stale after each use; bots should pass `signCount: 0` to `addCredential` to disable counter enforcement, or update the stored blob after each login (the simpler path is `signCount: 0`)

## Out of Scope

- **Password manager import:** Deferred. Bitwarden and Dashlane support passkey export, but import support requires testing against their actual export formats. 1Password has committed to supporting the FIDO CXF standard but has not shipped it yet. When 1Password ships CXF export, a `zuul passkey-import` command can be added.
- **Hardware authenticators:** `zuul passkey-register` uses a software virtual authenticator only. Hardware key support (YubiKey via `libfido2`) is a separate concern.
- **`--passkey` flag on `zuul get`:** Not needed. Unlike TOTP, passkey credential bytes require no transformation.
