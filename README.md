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

### Already have GPG keys on this machine?

`zuul setup` is non-destructive. If you already use `gpg`:

- **Personal key already in your keyring** — the wizard lists every secret key it finds and lets you pick yours. Nothing is regenerated; the chosen key just becomes your `pass` recipient. Pick the entry that matches `gpg --list-secret-keys`.
- **Personal key in a backup file** (`.asc` / `.gpg`) — import it first, then run setup:
  ```bash
  zuul import-key /path/to/my-key.asc
  zuul setup           # the imported key now appears in the picker
  ```
- **Bot key from another machine** (cross-machine replication) — see [Importing an existing bot key](#importing-an-existing-bot-key) below.
- **You don't want to share the keyring with zuul** — set `GNUPGHOME=~/.gnupg-zuul` in your shell before running `zuul setup`. Zuul honours `GNUPGHOME` and will keep its keys separate from your daily-driver keyring.

`zuul setup` never deletes or modifies an existing key. It does append `pinentry-mode loopback`, `allow-loopback-pinentry`, and longer cache TTLs to `~/.gnupg/gpg.conf` and `~/.gnupg/gpg-agent.conf` — these are required for unattended decryption. If that's a problem for your other GPG workflows, run zuul under a separate `GNUPGHOME`.

### Importing an existing bot key

Use this to reuse the same bot key across machines (so `~/.password-store/` syncs cleanly via Syncthing or similar):

```bash
# on the OLD machine — export the bot key + its passphrase
gpg --export-secret-keys <bot-fingerprint> > bot-key.asc
cp ~/.bot-pass.txt bot-pass.txt
scp bot-key.asc bot-pass.txt new-machine:

# on the NEW machine
zuul import-key bot-key.asc --as-bot --passphrase-file bot-pass.txt
zuul setup       # picks/generates your personal key, inits pass, etc.
zuul doctor
```

`zuul import-key --as-bot` imports the key, verifies the passphrase by unlocking the key in `gpg-agent`, writes the passphrase to `~/.bot-pass.txt` (mode 600), and saves the fingerprint to `~/.config/zuul/config.json`.

If you've also copied `~/.password-store/` and the old `config.json` over, you can skip `zuul setup` entirely — `zuul import-key --as-bot` is enough.

`zuul import-key` flags:

| Flag | Purpose |
|---|---|
| `--as-bot` | Configure the imported key as the Zuul bot key. |
| `--as-personal` | Configure the imported key as your personal recipient. |
| `--passphrase-file FILE` | Read the bot passphrase from a file (otherwise prompted). |
| `--fingerprint FPR` | Pick a specific fingerprint when the key file holds more than one or the key is already in the keyring. |

Without a role flag, `zuul import-key` just runs `gpg --import` for you and reports what was added — handy for moving a personal key between machines before running `zuul setup`.

## Day-to-day

```bash
zuul add metabase           # human stores a credential (interactive)
zuul get metabase           # agent retrieves it
zuul list                   # see what's stored
zuul remove metabase        # delete a credential
zuul doctor                 # diagnose runtime issues
zuul unlock                 # manually unlock the bot key (boot-time hook does this automatically)
zuul import-key key.asc     # import a GPG key file (see "Importing an existing bot key")
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
