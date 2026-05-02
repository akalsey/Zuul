# Security Model

## Trust assumptions

- Host machine is trusted.
- Disk encryption (FileVault on macOS, LUKS on Linux) is enabled.
- The bot user is isolated from other users on the system.

## Tradeoffs

This system prioritizes unattended automation over interactive security. The bot must run across reboots without anyone present to type a passphrase, which forces some compromises:

- The bot's GPG passphrase is stored on disk in `~/.bot-pass.txt`.
- The GPG key is unlocked automatically at boot.
- `gpg-agent` holds the decrypted key in memory indefinitely (cache TTL is one year).

`~/.bot-pass.txt` is the weakest link: any process running as the bot user can read it.

## Protection layers

| Layer | Protects |
|---|---|
| GPG encryption | secrets at rest |
| Passphrase file permissions (`chmod 600`) | the GPG passphrase |
| OS user isolation | the passphrase file from other users |
| Disk encryption | the entire system from offline attack |
| Per-file recipient lists | bot from decrypting human-only secrets |

## Why the bot can't decrypt human-only secrets

Even though the bot user can read the encrypted files in `~/.password-store/personal/`, they're encrypted only to `my-key`. The bot's `bot-key` is not a recipient, so GPG cannot decrypt them. This is enforced cryptographically, not by filesystem permissions.

## Why browser auth requires LLM credential visibility

For API-based services, credentials can be injected server-side without the LLM ever seeing the value. For browser-based authentication, the LLM must see the credential to type it into a form field. This is unavoidable.

The mitigation is to minimize exposure: the credential is retrieved at the moment of use via `pass show`, appears in exactly one tool result (the turn where it's typed), and is never stored in workspace files, memory, or messages. See `SKILL.md` for the rules the agent follows.

Preferred direction: move services from browser-based login to API-based access wherever possible, so credentials never need to enter the LLM context at all.

## Rejected alternatives

**Plaintext credentials file** (e.g. `~/.openclaw/credentials.json`)
Works, but credentials are unencrypted at rest. Any process running as the bot user can read them. No access scoping.

**OpenClaw native secrets** (`openclaw secrets configure`)
Interactive wizard limited to credentials OpenClaw itself needs (provider API keys, bot tokens). No support for arbitrary secrets. `openclaw secrets set <key> <value>` is an open feature request, not implemented.

**AgentSecrets**
Sound local architecture (OS keychain storage, `agentsecrets call` for zero-knowledge API calls). Rejected due to dependency on a cloud backend of uncertain operational status. Alpha software.

**Python `keyring` library**
Cross-platform and mature. But on macOS the Keychain prompts for the user's password after timeout or reboot; in a headless VM with no one to click "Allow," credential retrieval fails silently. On headless Linux, requires `keyrings.alt` fallback backend.

**`age` encryption**
Simpler than GPG, modern cryptography, portable. But `pass` provides directory structure, git integration, `pass ls` / `pass grep`, and a mature ecosystem. Since GPG is already part of the workflow, `pass` wins on organizational features.

## Future work

- Secret rotation workflows.
- Automated re-encryption of namespaces when keys change.
- Auditability — who can decrypt what.
- Guardrails to prevent accidental over-sharing (wrong recipient sets on insert).
- Atomic wrapper for dual-recipient insert (`pass init` / `insert` / revert) so a human can't leave the store in dual-recipient mode by accident.
