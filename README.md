# Zuul

Conversational secrets management for OpenClaw agents.

> *"There is no Dana, only Zuul."* — the Keymaster.

Zuul wraps `pass` and `gpg` into one opinionated command surface so an OpenClaw agent can retrieve credentials at the moment of use, without prompts, and without you ever editing a `.gpg-id` file by hand. When the agent needs a credential it doesn't have, `zuul get` exits with a structured error that tells the agent exactly what to ask the human to run — that's the conversational handoff.

## Install

```bash
npm install -g https://github.com/akalsey/Zuul.git
```

Zuul is not published to the npm registry (the `zuul` name there is an unrelated package), so install directly from GitHub.

Requires Node 18+, `gpg`, and `pass`. The `zuul setup` wizard checks for these and prints platform-specific install commands if anything is missing.

### `which zuul` is empty after install?

`npm install -g` succeeded but your shell can't find the binary — npm's global `bin` directory isn't on your `PATH`. Find it with:

```bash
echo "$(npm prefix -g)/bin"
```

Add that directory to your `PATH` in `~/.zshrc` / `~/.bashrc`:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Then `exec $SHELL` (or open a new terminal) and `which zuul` should resolve.

## One-time setup

```bash
zuul setup
```

This generates the bot GPG key, picks (or generates) your personal key, configures `gpg-agent` for unattended use, initializes the password store, and offers to install boot-time unlock as a launchd agent (macOS) or systemd user service (Linux). About two minutes, mostly waiting for `gpg` to gather entropy.

### Setting up a bot-only machine

On a dedicated bot/agent host you don't need a personal key — only the bot key matters. Run:

```bash
zuul setup --bot-only
```

The wizard skips personal-key picking and initializes the password store with the bot key as the sole recipient. Use this when the machine is purely an agent runtime and a human will never `zuul add` credentials directly on it. (For credentials added on your workstation, sync `~/.password-store/` over to the bot host — those entries are already encrypted to the bot key.)

### Already have GPG keys on this machine?

`zuul setup` is non-destructive. If you already use `gpg`:

- **Personal key already in your keyring** — the wizard lists every secret key it finds and lets you pick yours. Nothing is regenerated; the chosen key just becomes your `pass` recipient. Pick the entry that matches `gpg --list-secret-keys`.
- **Personal key in a backup file** (`.asc` / `.gpg`) — import it first, then run setup:
  ```bash
  zuul import-key /path/to/my-key.asc
  zuul setup           # the imported key now appears in the picker
  ```
- **Bot key from another machine** (cross-machine replication) — see [Moving a bot key between machines](#moving-a-bot-key-between-machines) below.
- **You don't want to share the keyring with zuul** — set `GNUPGHOME=~/.gnupg-zuul` in your shell before running `zuul setup`. Zuul honours `GNUPGHOME` and will keep its keys separate from your daily-driver keyring.

`zuul setup` never deletes or modifies an existing key. It does append `pinentry-mode loopback`, `allow-loopback-pinentry`, and longer cache TTLs to `~/.gnupg/gpg.conf` and `~/.gnupg/gpg-agent.conf` — these are required for unattended decryption. If that's a problem for your other GPG workflows, run zuul under a separate `GNUPGHOME`.

### Moving a bot key between machines

For a fresh deployment, **prefer `zuul setup`** (or `zuul setup --bot-only` on a bot host) — generating new keys is faster than moving one and the keys never leave the host. Move an existing bot key only when you actually need the same key on more than one machine. The two cases that come up:

- **Host migration** — moving an existing OpenClaw deployment to a new machine without re-encrypting the password store.
- **Pairing your workstation to a bot host** — the bot already exists, and you want to add credentials from your laptop, then sync `~/.password-store/` over to the bot.

Both flows use `zuul export` / `zuul import`: a single passphrase-encrypted file containing the bot key, its passphrase, and (optionally) the full password store.

#### `zuul export`

```bash
zuul export                        # bot key + passphrase only (workstation pairing)
zuul export --include-store        # also bundles ~/.password-store and zuul config (host migration)
zuul export --out my-bundle.gpg    # custom output path (default: zuul-export-<timestamp>.gpg)
```

`zuul export` is interactive — it prompts for a transit passphrase (entered twice) and refuses to write a bundle without one. The output is a GPG-symmetric-encrypted (AES-256) tarball with `0600` permissions. Treat it like any other secret in transit.

#### `zuul import`

```bash
zuul import bundle.gpg                            # interactive — prompts for transit passphrase
zuul import bundle.gpg --transit-passphrase-file F  # unattended — reads passphrase from file
zuul import                                       # auto-detect: /run/secrets/zuul-export
                                                  # passphrase: /run/secrets/zuul-export-pass
zuul import bundle.gpg --force                    # skip "replace existing bot key?" / "overwrite store?" prompts
```

The auto-detect path makes `zuul import` work as-is in a container entrypoint (mount the bundle and passphrase as Docker secrets — see [docs/container.md](docs/container.md)).

#### Host migration

Decommissioning machine `Foo`, bringing the same install up on `Bar`:

```bash
# on Foo
zuul export --include-store --out zuul-migration.gpg
scp zuul-migration.gpg bar:

# on Bar
zuul import zuul-migration.gpg
zuul doctor
shred -u zuul-migration.gpg
```

After import the new machine has the same bot key, passphrase, password store, and namespace. If `Bar` is also where a human will add credentials, follow up with `zuul setup` (without `--bot-only`) so a personal key joins the recipient list.

#### Pairing a workstation to a bot host

The bot is running on `Bar`; you want to add credentials from your laptop `Foo` and sync the encrypted store back. The simplest path is to give your laptop the same bot key — your `zuul add` then encrypts to bot + your personal key, and the bot keeps decrypting with its own copy.

```bash
# on Bar (the bot host)
zuul export --out bot-key-bundle.gpg
scp bot-key-bundle.gpg foo:

# on Foo (your laptop)
zuul import bot-key-bundle.gpg
zuul setup            # generates/picks your personal key, inits pass with bot + personal as recipients
zuul add metabase     # encrypts to bot + your personal key

# sync the store to the bot — pick whichever channel fits
rsync -a ~/.password-store/ bar:.password-store/

# wipe the transit copy
shred -u bot-key-bundle.gpg
```

**Security tradeoff:** this puts the bot's secret key on your laptop. A compromise of the laptop is a compromise of the bot's credential store. If that's not acceptable, skip the import and do `ssh bar zuul add metabase` instead — that keeps the bot key off your workstation entirely.

#### Does `zuul import` replace `zuul setup`?

| Scenario | Run `zuul setup` after import? |
|---|---|
| **Host migration** with `--include-store` (bundle had the password store) | No — import alone reconstitutes a working install. Run `zuul doctor` to confirm. |
| **Host migration** with `--include-store` onto a host that *also* needs a personal key | Yes — `zuul setup` is what adds the personal key to the recipient list. |
| **Workstation pairing** (no `--include-store`) | Yes — the laptop has no personal key and no `pass init` yet. |

When `zuul setup` runs after `zuul import`:

- **Bot key step is skipped automatically.** Setup notices that `cfg.botKeyId` is in the keyring and the passphrase file exists, prints `✓ reusing existing bot key <id>`, and moves on. No prompts about the bot key.
- **Personal key picker still runs.** Pick an existing key or generate a new one — that's what setup is for.
- **`pass init` runs again** with the chosen recipients (bot + personal). If a password store already exists (e.g. you imported with `--include-store`), this re-encrypts every entry to the new recipient set. The bot key from the bundle stays a recipient; the local personal key is added.
- **Boot-time unlock prompt** runs again — answer no if you already have one installed.

**Recipient mismatch.** If you import a *new* bot key on top of a machine where `pass` was already initialized with a *different* bot key (a key rotation, or swapping which bot a workstation pairs with), `~/.password-store/<namespace>/.gpg-id` still lists the old bot. New entries written there would not be readable by the bot you just imported. `zuul import` detects this:

- **Interactive:** warns and offers to re-init `pass` with the imported bot key + the existing personal key (default yes). Re-init re-encrypts every entry on the spot — it needs the *old* bot's secret key in the keyring to decrypt them first, so don't `gpg --delete-secret-key` the old bot until after the re-init.
- **Non-interactive** (no TTY): refuses with exit 1 and tells you the exact `pass init` command to run, or to re-run `zuul import` interactively. Containers should always be importing onto a fresh volume, where this case doesn't arise.

#### `zuul import-key` (raw `.asc` files)

If you have a raw `.asc` key file (exported with `gpg --export-secret-keys`, or generated by some other tool) rather than a `zuul export` bundle, use `zuul import-key`:

| Flag | Purpose |
|---|---|
| `--as-bot` | Configure the imported key as the Zuul bot key. |
| `--as-personal` | Configure the imported key as your personal recipient. |
| `--passphrase-file FILE` | Read the bot passphrase from a file (otherwise prompted). |
| `--fingerprint FPR` | Select a specific key when the file holds more than one or the key is already in the keyring. |

Without a role flag, `zuul import-key` just runs `gpg --import` and reports what was added — handy for moving a personal key between machines before running `zuul setup`.

The bot fingerprint (the 40-char hex GPG uses to identify a key) lives in `~/.config/zuul/config.json` as `botKeyId`; `zuul doctor` and `gpg --list-secret-keys` show it in human-readable form.

## Day-to-day

```bash
zuul add metabase           # human stores a credential (interactive)
zuul get metabase           # agent retrieves it
zuul list                   # see what's stored
zuul remove metabase        # delete a credential
zuul doctor                 # diagnose runtime issues
zuul unlock                 # manually unlock the bot key (boot-time hook does this automatically)
zuul export                 # produce an encrypted bundle for migration / pairing
zuul import bundle.gpg      # restore from a bundle (see "Moving a bot key between machines")
zuul import-key key.asc     # import a raw .asc GPG key file
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
