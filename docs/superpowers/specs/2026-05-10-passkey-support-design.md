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

**New flag:** `--passkey <blob>` — accepts a base64-encoded JSON credential blob.

**Interactive prompt:** `Passkey credential blob (base64 JSON, from zuul passkey-register) (optional):`

**Validation on input:** Before saving, `zuul add` must:
1. Base64-decode the value
2. Parse as JSON
3. Verify `credentialId`, `privateKey`, and `rpId` are present
4. Attempt to parse the private key to verify it is valid PKCS#8

If validation fails, warn with a clear message and abort without saving. This mirrors how `--otp` generates a TOTP code to confirm the key is valid before saving.

## New Command: `zuul passkey-register <service>`

Registers a fresh passkey with a service using a Playwright virtual authenticator, extracts the credential, and outputs the `zuul add` command for the human to run.

**Playwright dependency:** Playwright is not added to Zuul's core dependencies. At runtime, `zuul passkey-register` checks for Playwright using `require.resolve('playwright')`. If not installed:
- Prompt: `Playwright is required for passkey registration. Install it now? (npm install playwright)`
- If yes: run `npm install playwright` via the existing `exec.js` helper, then continue
- If no: print the install command and exit with a clear message

**Registration flow:**
1. Human runs: `zuul passkey-register github`
2. Command opens a Playwright browser window
3. Injects a CDP virtual authenticator (software-based, no hardware required) with `WebAuthn.enable` and `WebAuthn.addVirtualAuthenticator`
4. Navigates to the service URL (from the stored entry if it exists, otherwise prompts)
5. Human completes the passkey registration flow in the browser
6. Command detects registration completion via `WebAuthn.credentialAdded` CDP event
7. Calls `WebAuthn.getCredentials`, serializes the credential to JSON, base64-encodes it
8. Outputs the ready-to-run `zuul add` command with the blob pre-filled:
   ```
   Run this command to store the passkey:
     zuul add github --passkey eyJjcmVkZW50aWFsSWQiOi...
   ```

The human copies and runs the command. This keeps credential storage in the human's hands, consistent with Zuul's design.

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

A practical guide with code examples showing how to decode the blob and load it into virtual authenticators for Playwright, Puppeteer, and Selenium. Keeps the skill file concise while giving agents concrete implementation guidance.

## Out of Scope

- **Password manager import:** Deferred. Bitwarden and Dashlane support passkey export, but import support requires testing against their actual export formats. 1Password has committed to supporting the FIDO CXF standard but has not shipped it yet. When 1Password ships CXF export, a `zuul passkey-import` command can be added.
- **Hardware authenticators:** `zuul passkey-register` uses a software virtual authenticator only. Hardware key support (YubiKey via `libfido2`) is a separate concern.
- **`--passkey` flag on `zuul get`:** Not needed. Unlike TOTP, passkey credential bytes require no transformation.
