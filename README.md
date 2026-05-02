# Zuul

Conversational secrets management for OpenClaw agents.

> *"There is no Dana, only Zuul."* — the Keymaster.

Zuul wraps `pass` and `gpg` into one opinionated command surface so an OpenClaw agent can retrieve credentials at the moment of use, without prompts, and without you ever editing a `.gpg-id` file by hand. When the agent needs a credential it doesn't have, `zuul get` exits with a structured error that tells the agent exactly what to ask the human to run — that's the conversational handoff.

## Install

```bash
npm install -g zuul
```

Requires Node 18+, `gpg`, and `pass`. The `zuul setup` wizard checks for these and prints platform-specific install commands if anything is missing.

## One-time setup

```bash
zuul setup
```

This generates the bot GPG key, picks (or generates) your personal key, configures `gpg-agent` for unattended use, initializes the password store, and offers to install boot-time unlock as a launchd agent (macOS) or systemd user service (Linux). About two minutes, mostly waiting for `gpg` to gather entropy.

## Day-to-day

```bash
zuul add metabase           # human stores a credential (interactive)
zuul get metabase           # agent retrieves it
zuul list                   # see what's stored
zuul remove metabase        # delete a credential
zuul doctor                 # diagnose runtime issues
zuul unlock                 # manually unlock the bot key (boot-time hook does this automatically)
```

`zuul add` is interactive only — it refuses to run without a TTY, so an agent cannot accidentally call it. The password is always prompted with hidden input (never on the command line). Other fields can be supplied via flags or entered interactively:

```bash
zuul add metabase \
  --user alice@example.com \
  --url https://metabase.example.com \
  --otp otpauth://totp/Metabase:alice?secret=ABCDEF... \
  --field account-id=4421
```

| Flag | Field | Notes |
|---|---|---|
| `-u`, `--user` | `user` | Username / login |
| `--url` | `url` | Service URL |
| `--email` | `email` | When distinct from `user` |
| `--otp` | `otp` | TOTP secret (otpauth:// or base32) |
| `--note` | `note` | Free-form note |
| `-F`, `--field key=value` | `key` | Repeatable; for anything else |

## File format

Opinionated:

- Line 1 is the password. No prefix.
- Every other line is `key: value`. Keys are lowercase letters, digits, and dashes.
- The agent's skill teaches it to read this format.

## How agents use it

Drop the `secrets-management` skill into any OpenClaw agent (it lives at [`skills/secrets-management/`](./skills/secrets-management/)). The skill teaches the agent:

- Run `zuul get <service>` when it needs a credential.
- The first stdout line is the password; subsequent lines are `key: value` fields.
- If exit code is 2, the credential is missing — stop and ask the human to run `zuul add <service>`.
- Never echo credential values to the user, write them to memory files, or pass them into sub-agent instructions.

## Configuration

Zuul stores its config at `~/.config/zuul/config.json`. Override at runtime with environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ZUUL_NAMESPACE` | `bot` | Bot-readable namespace inside `pass` |
| `ZUUL_CONFIG_DIR` | `~/.config/zuul` | Config directory |
| `PASSWORD_STORE_DIR` | `~/.password-store` | `pass` storage location |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | generic failure |
| 2 | credential not found (agent should ask user to add it) |
| 3 | zuul not initialized (run `zuul setup`) |
| 4 | command requires a TTY |
| 5 | dependency missing (e.g., `gpg`, `pass`) |
| 64 | usage error |
| 130 | cancelled by Ctrl-C |

## Security model

See [`skills/secrets-management/security.md`](./skills/secrets-management/security.md) for the trust assumptions, threat model, and rejected alternatives.

The short version: the bot's GPG passphrase lives on disk in `~/.bot-pass.txt` (mode 600). This is the necessary tradeoff for unattended automation — there's no human present to type a passphrase at boot. Disk encryption (FileVault, LUKS) protects against offline attack; OS user isolation protects against other users on the system. Each secret is encrypted to specific recipients, so even though the bot user can read every `.gpg` file, it can't decrypt entries that aren't encrypted to its key.

## License

MIT
