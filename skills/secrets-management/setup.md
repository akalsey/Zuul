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
3. Generates a **bot** GPG key with a strong random passphrase.
4. Writes the passphrase to `~/.bot-pass.txt` (mode 600).
5. Configures `~/.gnupg/gpg.conf` (`pinentry-mode loopback`) and `~/.gnupg/gpg-agent.conf` (`allow-loopback-pinentry`, one-year cache TTL).
6. Initializes the password store: default recipient is your personal key; the bot-readable namespace (default `poppy/`) is dual-recipient (bot key + your key).
7. Saves `~/.config/zuul/config.json` with the namespace, both fingerprints, the passphrase file path, and the password store location.
8. Unlocks the bot key in `gpg-agent`.
9. Inserts a test secret, retrieves it, and removes it — to confirm the pipeline works.
10. Offers to install boot-time unlock as a launchd agent (macOS) or systemd user service (Linux).

After setup, the runtime calls `zuul get <service>` and gets the credential without prompting.

## Storage layout

`pass` stores each secret as an individually GPG-encrypted file. Paths represent namespaces:

```
~/.password-store/
  poppy/                    # bot-readable (dual-recipient)
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
  "namespace": "poppy",
  "botKeyId":  "ABCDEF0123456789...",
  "humanKeyId":"FEDCBA9876543210...",
  "passphraseFile": "/Users/poppy/.bot-pass.txt",
  "passwordStore": "/Users/poppy/.password-store",
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

## Cross-machine replication

`~/.password-store/` syncs between machines via Syncthing (or any tool that copies files). Files in transit are GPG-encrypted blobs — safe even if the sync channel is compromised. Both machines need the same bot key imported.

To migrate to a new machine:

```bash
# on the old machine
gpg --export-secret-keys <bot-fingerprint> > bot-key.asc
scp bot-key.asc ~/.bot-pass.txt ~/.config/zuul/config.json new-machine:

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
pass init --path poppy <bot-fingerprint> <your-fingerprint>

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

| Platform | Install |
|---|---|
| macOS | `brew install pass gnupg` |
| Debian/Ubuntu | `apt install pass gnupg` |
| Fedora/RHEL | `dnf install pass gnupg2` |
