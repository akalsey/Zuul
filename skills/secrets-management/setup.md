# Setup

The fast path is `gatepass setup`. This document covers what that wizard does under the hood and how to debug it.

## Fast path

```bash
npm install -g gatepass   # or: npm install -g github:akalsey/Gatepass
gatepass setup
```

The wizard:

1. Verifies `gpg` and `pass` are installed (prints platform-specific install commands if not).
2. Picks or generates your **personal** GPG key.
3. Picks or generates a **bot** GPG key. If one or more keys with a `Gatepass Bot` name or `gatepass-bot@…` email already exist in your keyring, the wizard offers to reuse one (prompting for its passphrase, which it verifies by unlocking the key in `gpg-agent`). Otherwise it generates a new bot key with a strong random passphrase.
4. Writes the (verified or generated) passphrase to `~/.bot-pass.txt` (mode 600).
5. Configures `~/.gnupg/gpg.conf` (`pinentry-mode loopback`) and `~/.gnupg/gpg-agent.conf` (`allow-loopback-pinentry`, one-year cache TTL).
6. Initializes the password store: default recipient is your personal key; the bot-readable namespace (default `bot/`) is dual-recipient (bot key + your key).
7. Saves `~/.config/gatepass/config.json` with the namespace, both fingerprints, the passphrase file path, and the password store location.
8. Unlocks the bot key in `gpg-agent`.
9. Inserts a test secret, retrieves it, and removes it — to confirm the pipeline works.
10. Offers to install boot-time unlock as a launchd agent (macOS) or systemd user service (Linux).

After setup, the runtime calls `gatepass get <service>` and gets the credential without prompting.

## Storage layout

`pass` stores each secret as an individually GPG-encrypted file. Paths represent namespaces:

```
~/.password-store/
  bot/                    # bot-readable (dual-recipient)
    metabase.gpg
    posthog.gpg
  personal/                 # human-only (single-recipient)
    bank.gpg
```

Access control is enforced by *which GPG keys each file is encrypted to*, not filesystem permissions alone. The bot's key physically cannot decrypt entries it isn't a recipient of. `gatepass setup` configures the bot-readable namespace so that everything inserted under it is automatically encrypted to both keys — there's no insert-time dance.

## Configuration

`~/.config/gatepass/config.json`:

```json
{
  "namespace": "bot",
  "botKeyId":  "ABCDEF0123456789...",
  "humanKeyId":"FEDCBA9876543210...",
  "passphraseFile": "/Users/alice/.bot-pass.txt",
  "passwordStore": "/Users/alice/.password-store",
  "bootUnlockInstalled": true
}
```

Environment overrides:

- `ZUUL_NAMESPACE` — bot-readable namespace
- `ZUUL_CONFIG_DIR` — config directory (default `~/.config/gatepass`)
- `PASSWORD_STORE_DIR` — pass storage location

## Boot-time unlock

`gatepass setup` offers to install one of:

- **macOS**: `~/Library/LaunchAgents/ai.openclaw.gatepass-unlock.plist`, loaded with `launchctl`.
- **Linux**: `~/.config/systemd/user/gatepass-unlock.service`, enabled with `systemctl --user`.

Either runs `gatepass unlock` at every login, which seeds `gpg-agent` so subsequent `gatepass get` calls don't prompt. If the service isn't installed, the bot will need `gatepass unlock` manually after every reboot.

## Importing existing keys

Three common cases:

### 1. You already have a personal GPG key in this machine's keyring

Just run `gatepass setup`. The personal-key picker lists every secret key in your keyring (`gpg --list-secret-keys`) and lets you reuse one. Nothing is regenerated, and your existing key isn't modified — it just becomes the recipient for everything you store under `pass`.

The only side-effect on your existing GPG setup: `gatepass setup` appends `pinentry-mode loopback` to `~/.gnupg/gpg.conf` and `allow-loopback-pinentry`, `default-cache-ttl`, and `max-cache-ttl` to `~/.gnupg/gpg-agent.conf`. These are required for the bot to decrypt without a TTY. If that conflicts with how you use GPG day-to-day (e.g., you rely on a graphical pinentry for signing email), run gatepass under a dedicated keyring:

```bash
export GNUPGHOME="$HOME/.gnupg-gatepass"
mkdir -p -m 700 "$GNUPGHOME"
gatepass setup
```

Then export `GNUPGHOME=$HOME/.gnupg-gatepass` in whatever environment runs `gatepass get` (the agent's launchd/systemd unit, your shell rc, etc.). Gatepass, gpg-agent, and pass all honour `GNUPGHOME`, so this fully isolates the two keyrings.

### 2. You have a personal key in a backup file (not yet in the keyring)

```bash
gatepass import-key /path/to/my-key.asc
gatepass setup           # the imported key now shows up in the picker
```

`gatepass import-key` with no role flag is a friendly wrapper around `gpg --import` — it imports the file and reports the new fingerprints. After that, `gatepass setup` treats the key like any other in-keyring key.

### 3. You're moving a bot key from another machine

```bash
gatepass import-key bot-key.asc --as-bot --passphrase-file old-bot-pass.txt
```

This:

1. Imports the key file into the GPG keyring.
2. Reads the bot passphrase from the file you pass (or prompts if the flag is omitted).
3. Writes it to `~/.bot-pass.txt` (mode 600, replacing any prior file — backed up in memory and restored if the unlock test fails).
4. Verifies by unlocking the key in `gpg-agent`.
5. Saves `botKeyId` (and `passphraseFile`) to `~/.config/gatepass/config.json`.

If the new machine has never run `gatepass setup`, follow up with `gatepass setup` — it will skip bot-key generation (sees the configured key) and just configure the personal key, pass store, and boot-time unlock.

### `gatepass import-key` flags

| Flag | Purpose |
|---|---|
| `--as-bot` | Configure the imported key as the Gatepass bot key. |
| `--as-personal` | Configure the imported key as your personal recipient. |
| `--passphrase-file FILE` | Read the bot passphrase from a file (otherwise prompted). |
| `--fingerprint FPR` | Pick a specific fingerprint when the file holds more than one key, or to assign a key that's already in the keyring. |

Switching keys when the password store already has entries: changing `humanKeyId` orphans every existing entry until you re-run `pass init <new-fingerprint>` and `pass init --path <namespace> <bot-fpr> <new-fingerprint>`, which re-encrypts the store. `gatepass import-key --as-personal` warns about this and asks for confirmation before updating config.

## Cross-machine replication

`~/.password-store/` syncs between machines via Syncthing (or any tool that copies files). Files in transit are GPG-encrypted blobs — safe even if the sync channel is compromised. Both machines need the same bot key imported.

To migrate to a new machine using the import command:

```bash
# on the old machine
gpg --export-secret-keys <bot-fingerprint> > bot-key.asc
scp bot-key.asc ~/.bot-pass.txt ~/.config/gatepass/config.json new-machine:

# on the new machine
mkdir -p ~/.config/gatepass && mv config.json ~/.config/gatepass/
gatepass import-key bot-key.asc --as-bot --passphrase-file .bot-pass.txt
rm .bot-pass.txt           # the import wrote ~/.bot-pass.txt for you
gatepass doctor
```

Or, if you'd rather do the steps by hand:

```bash
# on the new machine
gpg --import bot-key.asc
mkdir -p ~/.config/gatepass && mv config.json ~/.config/gatepass/
mv .bot-pass.txt ~/.bot-pass.txt
chmod 600 ~/.bot-pass.txt
gatepass unlock
gatepass doctor
```

## Debugging

`gatepass doctor` checks every prerequisite individually: tools installed, config present, both keys in keyring, passphrase file mode, password store initialized, namespace recipients, agent unlocked, boot-time unlock installed. Run it whenever something feels off.

If `gatepass get` fails:

- Exit code 2 — credential not stored. Run `gatepass add <service>`.
- Exit code 3 — `gatepass setup` hasn't been run.
- Exit code other — check `gatepass doctor`.

## Manual install (if `gatepass setup` won't work)

If you need to do this by hand, the commands `gatepass setup` runs under the hood are roughly:

```bash
# Generate bot key
gpg --batch --pinentry-mode loopback --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Name-Real: Gatepass Bot
Name-Email: gatepass-bot@$(hostname)
Expire-Date: 0
Passphrase: <generated>
%commit
EOF

# Configure agent
echo 'pinentry-mode loopback' >> ~/.gnupg/gpg.conf
cat >> ~/.gnupg/gpg-agent.conf <<EOF
allow-loopback-pinentry
default-cache-ttl 31536000
max-cache-ttl 31536000
EOF
gpgconf --reload gpg-agent

# Initialize pass
pass init <your-fingerprint>
pass init --path bot <bot-fingerprint> <your-fingerprint>

# Stash passphrase
echo '<bot-passphrase>' > ~/.bot-pass.txt
chmod 600 ~/.bot-pass.txt

# Unlock
gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file ~/.bot-pass.txt \
    --local-user <bot-fingerprint> \
    --sign <<< gatepass-unlock
```

## Dependencies

`pass` requires `gpg` and standard Unix tools. `gatepass` itself requires Node 18+.
For TOTP support (`gatepass add --otp` verification and `gatepass get --otp`), install
`oathtool` from the `oath-toolkit` package.

| Platform | Install |
|---|---|
| macOS | `brew install pass gnupg oath-toolkit` |
| Debian/Ubuntu | `apt install pass gnupg oathtool` |
| Fedora/RHEL | `dnf install pass gnupg2 oathtool` |
