# Setup

The fast path is `zuul setup`. This document covers what that wizard does under the hood and how to debug it.

## Fast path

```bash
npm install -g zuul   # or: npm install -g github:akalsey/Zuul
zuul setup
```

The wizard:

1. Verifies `gpg` and `pass` are installed (prints platform-specific install commands if not).
2. Picks or generates your **personal** GPG key.
3. Picks or generates a **bot** GPG key. If one or more keys with a `Zuul Bot` name or `zuul-bot@…` email already exist in your keyring, the wizard offers to reuse one (prompting for its passphrase, which it verifies by unlocking the key in `gpg-agent`). Otherwise it generates a new bot key with a strong random passphrase.
4. Writes the (verified or generated) passphrase to `~/.bot-pass.txt` (mode 600).
5. Configures `~/.gnupg/gpg.conf` (`pinentry-mode loopback`) and `~/.gnupg/gpg-agent.conf` (`allow-loopback-pinentry`, one-year cache TTL).
6. Initializes the password store: default recipient is your personal key; the bot-readable namespace (default `bot/`) is dual-recipient (bot key + your key).
7. Saves `~/.config/zuul/config.json` with the namespace, both fingerprints, the passphrase file path, and the password store location.
8. Unlocks the bot key in `gpg-agent`.
9. Inserts a test secret, retrieves it, and removes it — to confirm the pipeline works.
10. Offers to install boot-time unlock as a launchd agent (macOS) or systemd user service (Linux).

After setup, the runtime calls `zuul get <service>` and gets the credential without prompting.

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

Access control is enforced by *which GPG keys each file is encrypted to*, not filesystem permissions alone. The bot's key physically cannot decrypt entries it isn't a recipient of. `zuul setup` configures the bot-readable namespace so that everything inserted under it is automatically encrypted to both keys — there's no insert-time dance.

## Configuration

`~/.config/zuul/config.json`:

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
- `ZUUL_CONFIG_DIR` — config directory (default `~/.config/zuul`)
- `PASSWORD_STORE_DIR` — pass storage location

## Boot-time unlock

`zuul setup` offers to install one of:

- **macOS**: `~/Library/LaunchAgents/ai.openclaw.zuul-unlock.plist`, loaded with `launchctl`.
- **Linux**: `~/.config/systemd/user/zuul-unlock.service`, enabled with `systemctl --user`.

Either runs `zuul unlock` at every login, which seeds `gpg-agent` so subsequent `zuul get` calls don't prompt. If the service isn't installed, the bot will need `zuul unlock` manually after every reboot.

## Importing existing keys

Three common cases:

### 1. You already have a personal GPG key in this machine's keyring

Just run `zuul setup`. The personal-key picker lists every secret key in your keyring (`gpg --list-secret-keys`) and lets you reuse one. Nothing is regenerated, and your existing key isn't modified — it just becomes the recipient for everything you store under `pass`.

The only side-effect on your existing GPG setup: `zuul setup` appends `pinentry-mode loopback` to `~/.gnupg/gpg.conf` and `allow-loopback-pinentry`, `default-cache-ttl`, and `max-cache-ttl` to `~/.gnupg/gpg-agent.conf`. These are required for the bot to decrypt without a TTY. If that conflicts with how you use GPG day-to-day (e.g., you rely on a graphical pinentry for signing email), run zuul under a dedicated keyring:

```bash
export GNUPGHOME="$HOME/.gnupg-zuul"
mkdir -p -m 700 "$GNUPGHOME"
zuul setup
```

Then export `GNUPGHOME=$HOME/.gnupg-zuul` in whatever environment runs `zuul get` (the agent's launchd/systemd unit, your shell rc, etc.). Zuul, gpg-agent, and pass all honour `GNUPGHOME`, so this fully isolates the two keyrings.

### 2. You have a personal key in a backup file (not yet in the keyring)

```bash
zuul import-key /path/to/my-key.asc
zuul setup           # the imported key now shows up in the picker
```

`zuul import-key` with no role flag is a friendly wrapper around `gpg --import` — it imports the file and reports the new fingerprints. After that, `zuul setup` treats the key like any other in-keyring key.

### 3. You're moving a bot key from another machine

```bash
zuul import-key bot-key.asc --as-bot --passphrase-file old-bot-pass.txt
```

This:

1. Imports the key file into the GPG keyring.
2. Reads the bot passphrase from the file you pass (or prompts if the flag is omitted).
3. Writes it to `~/.bot-pass.txt` (mode 600, replacing any prior file — backed up in memory and restored if the unlock test fails).
4. Verifies by unlocking the key in `gpg-agent`.
5. Saves `botKeyId` (and `passphraseFile`) to `~/.config/zuul/config.json`.

If the new machine has never run `zuul setup`, follow up with `zuul setup` — it will skip bot-key generation (sees the configured key) and just configure the personal key, pass store, and boot-time unlock.

### `zuul import-key` flags

| Flag | Purpose |
|---|---|
| `--as-bot` | Configure the imported key as the Zuul bot key. |
| `--as-personal` | Configure the imported key as your personal recipient. |
| `--passphrase-file FILE` | Read the bot passphrase from a file (otherwise prompted). |
| `--fingerprint FPR` | Pick a specific fingerprint when the file holds more than one key, or to assign a key that's already in the keyring. |

Switching keys when the password store already has entries: changing `humanKeyId` orphans every existing entry until you re-run `pass init <new-fingerprint>` and `pass init --path <namespace> <bot-fpr> <new-fingerprint>`, which re-encrypts the store. `zuul import-key --as-personal` warns about this and asks for confirmation before updating config.

## Cross-machine replication

`~/.password-store/` syncs between machines via Syncthing (or any tool that copies files). Files in transit are GPG-encrypted blobs — safe even if the sync channel is compromised. Both machines need the same bot key imported.

To migrate to a new machine using the import command:

```bash
# on the old machine
gpg --export-secret-keys <bot-fingerprint> > bot-key.asc
scp bot-key.asc ~/.bot-pass.txt ~/.config/zuul/config.json new-machine:

# on the new machine
mkdir -p ~/.config/zuul && mv config.json ~/.config/zuul/
zuul import-key bot-key.asc --as-bot --passphrase-file .bot-pass.txt
rm .bot-pass.txt           # the import wrote ~/.bot-pass.txt for you
zuul doctor
```

Or, if you'd rather do the steps by hand:

```bash
# on the new machine
gpg --import bot-key.asc
mkdir -p ~/.config/zuul && mv config.json ~/.config/zuul/
mv .bot-pass.txt ~/.bot-pass.txt
chmod 600 ~/.bot-pass.txt
zuul unlock
zuul doctor
```

## Debugging

`zuul doctor` checks every prerequisite individually: tools installed, config present, both keys in keyring, passphrase file mode, password store initialized, namespace recipients, agent unlocked, boot-time unlock installed. Run it whenever something feels off.

If `zuul get` fails:

- Exit code 2 — credential not stored. Run `zuul add <service>`.
- Exit code 3 — `zuul setup` hasn't been run.
- Exit code other — check `zuul doctor`.

## Manual install (if `zuul setup` won't work)

If you need to do this by hand, the commands `zuul setup` runs under the hood are roughly:

```bash
# Generate bot key
gpg --batch --pinentry-mode loopback --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Name-Real: Zuul Bot
Name-Email: zuul-bot@$(hostname)
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
    --sign <<< zuul-unlock
```

## Dependencies

`pass` requires `gpg` and standard Unix tools. `zuul` itself requires Node 18+.
For TOTP support (`zuul add --otp` verification and `zuul get --otp`), install
`oathtool` from the `oath-toolkit` package.

| Platform | Install |
|---|---|
| macOS | `brew install pass gnupg oath-toolkit` |
| Debian/Ubuntu | `apt install pass gnupg oathtool` |
| Fedora/RHEL | `dnf install pass gnupg2 oathtool` |
