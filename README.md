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

Run this on the bot host — the machine where the agent will run `zuul get`:

```bash
zuul setup
```

Generates the bot GPG key, picks (or generates) your personal key, configures `gpg-agent` for unattended use, initializes the password store, and offers to install a boot-time unlock service. About two minutes.

If you plan to manage credentials directly on the bot (SSH in and run `zuul add` there), that's all the setup you need. To run `zuul add` from your workstation instead, see [Managing your keys remotely](#managing-your-keys-remotely) below.

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

## Managing your keys remotely

Prefer to run `zuul add` from your workstation instead of SSH'ing into the bot? Pair the workstation with the bot host so both hold the bot key. Then credentials you add on the workstation are already encrypted to the bot — getting them onto the bot is just a file copy.

To pair, run `zuul setup` on the bot first (above), then:

1. Install zuul, `gpg`, and `pass` on the workstation.
2. On the bot, package the bot key into an encrypted bundle. You'll be prompted for a transit passphrase — type it twice:
   ```bash
   zuul export --out zuul-bot.gpg
   ```
3. Move `zuul-bot.gpg` to your workstation. The bundle is encrypted, so any transport is fine (`scp`, USB stick, etc.).
4. On the workstation, import the bundle. You'll be prompted for the transit passphrase from step 2:
   ```bash
   zuul import zuul-bot.gpg
   ```
5. Run `zuul setup` on the workstation. It detects the imported bot key, picks (or generates) your personal key, and initializes a local password store with both keys as recipients.
6. Shred the transit copy on both machines: `shred -u zuul-bot.gpg`.

`zuul doctor` on each side confirms the pairing. For edge cases (existing personal keys, key rotations, container hosts), see [docs/host-migration.md](docs/host-migration.md).

### Sync credentials to the bot host

`zuul add` writes encrypted entries into `~/.password-store/` on whatever machine you run it on. Once a workstation is paired to a bot host, getting credentials to the bot is just a file copy: every entry under `~/.password-store/` is already encrypted to the bot key, so it's safe over any transport. Land the files at `~/.password-store/` on the bot, preserving the directory layout — `bot/metabase.gpg` must stay under `bot/`, not get flattened to the root.

See [docs/syncing-credentials.md](docs/syncing-credentials.md) for rsync, scp, and Syncthing recipes.

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
