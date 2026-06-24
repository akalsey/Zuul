---
name: secrets-management
description: Retrieve credentials at the moment of use for authenticating to web services, APIs, or browser-based logins. Use whenever a task requires a password, API token, or other secret. Credentials are retrieved through the `gatepass` CLI, which decrypts them with a bot GPG key that is unlocked once at boot.
---

# Secrets Management

## When to use

Whenever a task requires authenticating to a service — typing a password into a browser form, calling an API that needs a token, or anything else that requires a secret. Retrieve credentials only at the moment they are needed, never speculatively or in advance.

## Retrieving a credential

```bash
gatepass get <service>
```

Example: `gatepass get metabase`

The output follows an opinionated format:

- **Line 1** is the password, with no prefix.
- **Subsequent lines** are `key: value` fields, lowercase keys.

```
the-actual-password
user: alice@example.com
url: https://metabase.example.com
note: anything else relevant
```

Standard field names you may encounter:

| Field | Meaning |
|---|---|
| `user` | Username or login. Type into the username field. |
| `url` | Service URL. Navigate here for browser logins. |
| `email` | Email, when distinct from `user` (e.g. recovery email). |
| `otp` | TOTP secret (otpauth:// URI or base32). Use `gatepass get --otp` to generate a current code — never try to compute one yourself. |
| `passkey` | WebAuthn credential blob (base64 JSON). When present, use passkey authentication — do not type a password. Decode and load into your browser automation tool's virtual authenticator before navigating to the login page. See `docs/passkey-automation.md` for examples. |
| `note` | Free-form text. |

Other keys may appear — they follow the same `key: value` form and are always lowercase.

For browser-based logins: navigate to the `url`, type the `user` into the username field, and type the first line into the password field.

## Getting a TOTP code

If a service requires a one-time password (2FA) and the entry has an `otp`
field, ask gatepass for a current code instead of trying to compute one yourself:

```bash
gatepass get --otp <service>
```

Example: `gatepass get --otp metabase` prints a single 6-digit code on one line and
nothing else. Use it immediately — TOTP codes rotate every 30 seconds.

If the credential isn't stored, or it exists but has no `otp` field, the
command exits with code 2 and tells you what `gatepass add` invocation to suggest
to the human. Treat it the same way as a missing credential: stop and ask.

## Listing what's available

```bash
gatepass list
```

## When a credential is missing

**Always run `gatepass list` before concluding a credential is missing.** The
service name you guessed may not match the stored key name. For example, if a
task needs a Google API key you might reach for `gatepass get google-api-key`,
but the key is actually stored as `google`. Do not repeatedly retry variations
of a name you invented. Instead, run `gatepass list` to see the actual keys and
pick the most plausible match. Only report a credential as missing after you
have run `gatepass list` and found either no plausible match, or every plausible
match has failed.

If `gatepass get <service>` exits with code 2, the credential is either not
stored, or (when called with `--otp`) is stored without an `otp` field. The
error message on stderr will name the missing piece and quote the exact
command the user should run, e.g.:

```
gatepass: credential '<service>' is not stored.
Ask the user to add it by running:
  gatepass add <service>
```

Stop the task at that point. Tell the user which service is missing and quote the `gatepass add` command back to them. Do not try to authenticate by other means, do not guess credentials, and do not retry.

## Rules

- **Retrieve credentials only at the moment you need them.** Do not fetch them in advance "to have them ready."
- **Never include credential values in messages to the user.** Not in summaries, not in confirmations, not in error reports.
- **Never write credential values to memory files, daily notes, or any workspace file.** Including `MEMORY.md`, scratchpads, logs, or transcripts you control.
- **Never pass credential values into sub-agent task instructions.** If a sub-agent needs a credential, the sub-agent should retrieve it itself using this skill.
- **If `gatepass get` exits non-zero with code 2,** run `gatepass list` first to check whether the credential is stored under a different name than you guessed. Only ask the user to add it once `list` shows no plausible match (or the plausible matches have failed). Do not retry invented name variations.
- **If `gatepass get` exits non-zero with any other code,** something is wrong with the runtime (key not unlocked, config missing, etc.). Run `gatepass doctor` to diagnose, and report the result to the user rather than working around it.
- **If authentication fails after `gatepass get` succeeded,** report which service failed and the error message — never the credential value.
- **If a browser session expires mid-task,** stop and ask the user to re-authenticate. Do not silently retrieve the credential and re-login without telling them.
- **If a credential has a `passkey:` field,** authenticate using the passkey credential rather than the password. The `passkey:` value is a base64-encoded JSON blob. Load it into your browser automation tool's virtual authenticator before navigating to the login page. The password field may also be present but should be ignored for login.

## Why these rules matter

For API-based auth, credentials can sometimes be injected without the agent seeing them. For browser-based auth, the agent must see the credential to type it into a form — that's unavoidable. The mitigation is to minimize where the value appears: it shows up in exactly one tool result (the `gatepass get` call) and is never copied into any other artifact.

## Adding new credentials

This is a human task, not an agent task. `gatepass add` is interactive only and refuses to run without a TTY. If a credential is missing, ask the user to run `gatepass add <service>` themselves.

## Reference

- `setup.md` — what `gatepass setup` does under the hood, and how to debug it
- `security.md` — trust assumptions, threat model, rejected alternatives
