# Setup

Host configuration for the secrets management system. This is a human task, run once per machine.

## Overview

A deterministic, file-based secret store using GPG for encryption and `pass` for organization. Boot-time key unlock enables unattended access for bot-scoped secrets. Designed to run on macOS and Linux, replicate across machines via Syncthing, and never prompt the bot for a passphrase.

## Components

- `pass` — filesystem-based password store
- GnuPG — encryption layer
- `gpg-agent` — passphrase caching for unattended operation
- Syncthing (optional) — cross-machine replication

## Install dependencies

macOS (Homebrew):
```bash
brew install pass gnupg gnu-getopt
```

Linux (Debian/Ubuntu):
```bash
apt install pass gnupg
```

## Storage layout

`pass` stores each secret as an individually GPG-encrypted file. Paths represent namespaces:

```
~/.password-store/
  poppy/                    # bot-readable
    metabase.gpg
    posthog.gpg
    google-workspace.gpg
  personal/                 # human-only
    bank.gpg
  shared/                   # multi-recipient
    team-credentials.gpg
```

Access control is enforced by *which GPG keys each file is encrypted to*, not filesystem permissions alone. The bot's key physically cannot decrypt entries it isn't a recipient of.

## GPG key model

Two separate keys:

- **`poppy-key`** — bot key. Has a passphrase. Unlocked automatically at boot. Used only by the unattended runtime.
- **`my-key`** — human key. Used interactively. Not available to the bot.

Some entries are encrypted to both keys (multi-recipient) when both human and bot need access.

## Bot runtime configuration

### `~/.gnupg/gpg.conf`

```
pinentry-mode loopback
```

### `~/.gnupg/gpg-agent.conf`

```
allow-loopback-pinentry
default-cache-ttl 31536000
max-cache-ttl 31536000
```

### Passphrase file

```bash
echo 'the-bot-passphrase' > ~/.bot-pass.txt
chmod 600 ~/.bot-pass.txt
```

### Boot-time unlock

Run once at startup to seed the agent cache:

```bash
gpg --batch --yes \
  --pinentry-mode loopback \
  --passphrase-file ~/.bot-pass.txt \
  --sign <<< "init" >/dev/null 2>&1
```

After this, `pass show` works without prompting.

### Bot environment

The bot's runtime (launchd plist, systemd unit, etc.) must define:

```
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
HOME=/Users/poppy
GNUPGHOME=/Users/poppy/.gnupg
PASSWORD_STORE_GPG_OPTS="--batch --yes"
```

Do not rely on shell profiles or interactive environment.

## Adding credentials

### Single-recipient (default — encrypted to your key only)

```bash
pass insert -m personal/bank
```

`-m` enables multi-line input. End with Ctrl+D.

### Multi-field format

Password on the first line, key/value fields on subsequent lines:

```
supersecretpassword
username: poppy@signalwire.com
url: https://metabase.example.com
notes: anything else relevant
```

### Bot-readable (encrypted to both keys)

`pass init` sets the recipient list for the *current directory*. To insert a credential the bot can decrypt:

```bash
pass init poppy-key my-key      # switch to dual-recipient
pass insert poppy/service       # insert under poppy/ namespace
pass init my-key                # revert to single-recipient default
```

If you forget the revert, subsequent inserts go to both recipients unintentionally. Consider scripting this as an atomic wrapper.

## Cross-machine replication

`~/.password-store/` syncs between machines via Syncthing. Files in transit are GPG-encrypted blobs — safe even if the sync channel is compromised. Both machines need the same `poppy-key` imported.

Adding a credential on one machine makes it available on the other within seconds, with no SSH or remote access required.

## Migration to a new host

1. Export the bot key:
   ```bash
   gpg --export-secret-keys poppy-key > poppy-key.asc
   ```
2. On the new machine:
   ```bash
   gpg --import poppy-key.asc
   ```
3. Replicate `~/.gnupg/` config files, `~/.bot-pass.txt`, and the `~/.password-store/poppy/` namespace.
4. Run the boot-time unlock command.

## Dependencies

`pass` requires `gpg`, GNU `getopt`, and standard Unix tools. On macOS, install `gnu-getopt` via Homebrew — the BSD `getopt` shipped with macOS is incompatible.
