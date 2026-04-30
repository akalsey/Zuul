---
name: secrets-management
description: Retrieve credentials at the moment of use for authenticating to web services, APIs, or browser-based logins. Use whenever a task requires a password, API token, or other secret. Credentials are retrieved through the `zuul` CLI, which decrypts them with a bot GPG key that is unlocked once at boot.
---

# Secrets Management

## When to use

Whenever a task requires authenticating to a service — typing a password into a browser form, calling an API that needs a token, or anything else that requires a secret. Retrieve credentials only at the moment they are needed, never speculatively or in advance.

## Retrieving a credential

```bash
zuul get <service>
```

Example: `zuul get metabase`

The first line of stdout is the password. Subsequent lines are key/value fields:

```
the-actual-password
username: alice@example.com
url: https://metabase.example.com
notes: anything else relevant
```

For browser-based logins: navigate to the `url`, type the `username` into the username field, and type the first line into the password field.

## Listing what's available

```bash
zuul list
```

## When a credential is missing

If `zuul get <service>` exits with code 2, the credential is not stored. The error message on stderr will be:

```
zuul: credential '<service>' is not stored.
Ask the user to add it by running:
  zuul add <service>
```

Stop the task at that point. Tell the user which service is missing and quote the `zuul add` command back to them. Do not try to authenticate by other means, do not guess credentials, and do not retry.

## Rules

- **Retrieve credentials only at the moment you need them.** Do not fetch them in advance "to have them ready."
- **Never include credential values in messages to the user.** Not in summaries, not in confirmations, not in error reports.
- **Never write credential values to memory files, daily notes, or any workspace file.** Including `MEMORY.md`, scratchpads, logs, or transcripts you control.
- **Never pass credential values into sub-agent task instructions.** If a sub-agent needs a credential, the sub-agent should retrieve it itself using this skill.
- **If `zuul get` exits non-zero with code 2,** the credential is missing — ask the user to add it. Do not try alternatives.
- **If `zuul get` exits non-zero with any other code,** something is wrong with the runtime (key not unlocked, config missing, etc.). Run `zuul doctor` to diagnose, and report the result to the user rather than working around it.
- **If authentication fails after `zuul get` succeeded,** report which service failed and the error message — never the credential value.
- **If a browser session expires mid-task,** stop and ask the user to re-authenticate. Do not silently retrieve the credential and re-login without telling them.

## Why these rules matter

For API-based auth, credentials can sometimes be injected without the agent seeing them. For browser-based auth, the agent must see the credential to type it into a form — that's unavoidable. The mitigation is to minimize where the value appears: it shows up in exactly one tool result (the `zuul get` call) and is never copied into any other artifact.

## Adding new credentials

This is a human task, not an agent task. `zuul add` is interactive only and refuses to run without a TTY. If a credential is missing, ask the user to run `zuul add <service>` themselves.

## Reference

- `setup.md` — what `zuul setup` does under the hood, and how to debug it
- `security.md` — trust assumptions, threat model, rejected alternatives
