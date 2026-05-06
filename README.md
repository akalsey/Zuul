# Zuul

Conversational secrets management for OpenClaw agents.

> *"There is no Dana, only Zuul."* — the Keymaster.

Zuul wraps `pass` and `gpg` into one opinionated command surface so an OpenClaw agent can retrieve credentials at the moment of use, without prompts. When the agent needs a credential it doesn't have, `zuul get` exits with a structured error that tells the agent exactly what to ask the human to run — that's the conversational handoff.

## Install

```bash
npm install -g https://github.com/akalsey/Zuul.git
```

Requires Node 18+, `gpg`, and `pass`. Zuul is not on the npm registry; install directly from GitHub.

## Setup

```bash
zuul setup
```

Generates the bot GPG key, picks (or generates) your personal key, configures `gpg-agent` for unattended use, initializes the password store, and offers to install a boot-time unlock service. About two minutes.

For bot-only hosts, machines that already use GPG, or moving a bot key between machines, see [docs/host-migration.md](docs/host-migration.md).

## Day-to-day

```bash
zuul add metabase           # human stores a credential (interactive)
zuul get metabase           # agent retrieves it
zuul list                   # see what's stored
zuul remove metabase        # delete a credential
zuul doctor                 # diagnose runtime issues
zuul unlock                 # manually unlock the bot key
```

`zuul add` is interactive only and prompts for the password with hidden input. Other fields can be supplied via flags or entered interactively:

```bash
zuul add metabase \
  --user alice@example.com \
  --url https://metabase.example.com \
  --otp otpauth://totp/Metabase:alice?secret=ABCDEF... \
  --field account-id=4421
```

| Flag | Field |
|---|---|
| `-u`, `--user` | `user` |
| `--url` | `url` |
| `--email` | `email` |
| `--otp` | `otp` (otpauth:// or base32) |
| `--note` | `note` |
| `-F`, `--field key=value` | arbitrary `key` |

## Sync credentials to the bot host

Zuul does not move credentials between machines. Once you've paired a workstation to a bot host (so both have the bot key), use whatever transport fits — everything in `~/.password-store/` is encrypted to the bot key, so it's safe over any channel. Keep the directory structure intact: the destination must be `~/.password-store/` on the bot, not flattened.

```bash
# rsync — one-shot or cron
rsync -a --delete ~/.password-store/ bar:.password-store/

# scp — one-off
scp -r ~/.password-store/. bar:.password-store/

# Syncthing — share ~/.password-store on both hosts; set the workstation
# folder type to "Send Only" so the bot can't push back.
```

See [docs/syncing-credentials.md](docs/syncing-credentials.md) for fuller recipes and gotchas.

## Use it from an agent

Drop the `secrets-management` skill into any OpenClaw agent (it lives at [`skills/secrets-management/`](./skills/secrets-management/)). The skill teaches the agent to call `zuul get <service>`, parse the response (line 1 is the password; subsequent lines are `key: value`), and ask the human to run `zuul add <service>` when a credential is missing (exit code 2).

## More

- [docs/troubleshooting.md](docs/troubleshooting.md) — install snags, locked bot key, sync issues
- [docs/host-migration.md](docs/host-migration.md) — moving a bot key, pairing a workstation, `zuul export` / `zuul import`
- [docs/syncing-credentials.md](docs/syncing-credentials.md) — rsync, scp, and Syncthing recipes for shipping the password store to the bot
- [docs/personal-key-migration.md](docs/personal-key-migration.md) — moving a personal key
- [docs/container.md](docs/container.md) — running zuul in a container
- [`skills/secrets-management/SKILL.md`](./skills/secrets-management/SKILL.md) — agent contract, exit codes
- [`skills/secrets-management/setup.md`](./skills/secrets-management/setup.md) — environment variables, file format, boot-time unlock
- [`skills/secrets-management/security.md`](./skills/secrets-management/security.md) — trust assumptions and threat model

## License

MIT
