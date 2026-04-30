---
name: secrets-management
description: Retrieve credentials at the moment of use for authenticating to web services, APIs, or browser-based logins. Use whenever a task requires a password, API token, or other secret. Credentials are stored in `pass` under the `bot/` namespace and decrypted with the bot's GPG key, which is unlocked once at boot.
---

# Secrets Management

## When to use

Whenever a task requires authenticating to a service — typing a password into a browser form, calling an API that needs a token, or anything else that requires a secret. Retrieve credentials only at the moment they are needed, never speculatively or in advance.

## Retrieving a credential

```bash
pass show bot/SERVICE
```

Replace `SERVICE` with the service name (e.g. `pass show bot/metabase`).

The first line of output is the password. Subsequent lines are key/value fields:

```
the-actual-password
username: alice@example.com
url: https://metabase.example.com
notes: anything else relevant
```

For browser-based logins: navigate to the `url`, type the `username` into the username field, and type the first line into the password field.

## Listing what's available

```bash
pass ls bot/
```

## Rules

- **Retrieve credentials only at the moment you need them.** Do not fetch them in advance "to have them ready."
- **Never include credential values in messages to the user.** Not in summaries, not in confirmations, not in error reports.
- **Never write credential values to memory files, daily notes, or any workspace file.** Including `MEMORY.md`, scratchpads, logs, or transcripts you control.
- **Never pass credential values into sub-agent task instructions.** If a sub-agent needs a credential, the sub-agent should retrieve it itself using this skill.
- **If `pass show` errors,** the credential is missing. Ask the user to add it rather than trying alternatives, guessing, or falling back to other auth methods.
- **If authentication fails,** report which service failed and the error message — never the credential value.
- **If a browser session expires mid-task,** stop and ask the user to re-authenticate. Do not silently retrieve the credential and re-login without telling them.

## Why these rules matter

For API-based auth, credentials can sometimes be injected without the agent seeing them. For browser-based auth, the agent must see the credential to type it into a form — that's unavoidable. The mitigation is to minimize where the value appears: it shows up in exactly one tool result (the `pass show` call) and is never copied into any other artifact.

## Adding new credentials

This is a human task, not an agent task. If a credential is missing, ask the user to add it — see `setup.md` for the procedure.

## Reference

- `setup.md` — host configuration: installing `pass`, GPG keys, `gpg-agent`, boot-time unlock, cross-machine replication
- `security.md` — trust assumptions, threat model, rejected alternatives
