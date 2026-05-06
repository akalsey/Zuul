# Troubleshooting

A grab-bag of the things that go wrong most often, and how to fix them. Migration- and container-specific issues live in [host-migration.md](host-migration.md) and [container.md](container.md); this doc covers the day-to-day stuff.

Run `zuul doctor` first — it checks the keyring, passphrase file, password store, and boot-unlock hook in one shot, and most of the symptoms below show up there as a failed check with a hint.

## Install and PATH

### `which zuul` is empty after install

`npm install -g` succeeded but your shell can't find the binary — npm's global `bin` directory isn't on your `PATH`. Find it with:

```bash
echo "$(npm prefix -g)/bin"
```

Add that directory to your `PATH` in `~/.zshrc` / `~/.bashrc`:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Then `exec $SHELL` (or open a new terminal) and `which zuul` should resolve.

## Bot key isn't unlocked on the bot host

Symptoms: `zuul get` hangs or errors with a passphrase prompt; the agent reports `gpg: decryption failed: No secret key` or pinentry timeouts; everything works the first time after you log in but breaks after a reboot.

Cause: `gpg-agent` caches the bot key only after something asks it to decrypt. On a freshly-booted host with no human at the keyboard, nothing has triggered that — the key is on disk but locked.

Fix: install boot-time unlock so `zuul unlock` runs automatically at boot/login.

```bash
zuul setup            # answer "yes" to the boot-time unlock prompt
```

That installs a launchd agent (macOS) or systemd user service (Linux) that calls `zuul unlock` at session start. The bot key then stays cached for `default-cache-ttl 31536000` (one year) — i.e. effectively the lifetime of the session.

Verify:

```bash
zuul doctor                          # "boot-time unlock installed" should be green
launchctl list | grep zuul-unlock    # macOS
systemctl --user status zuul-unlock  # Linux
```

If `zuul doctor` reports the hook installed but the key is still locked after reboot, run `zuul unlock` by hand and check the log (`/tmp/com.zuul.unlock.log` on macOS, `journalctl --user -u zuul-unlock` on Linux) — usually a missing `~/.bot-pass.txt` or a permissions problem on `~/.gnupg/`.

In a container there's no init system to run the launchd/systemd hook; call `zuul unlock` from the entrypoint instead — see [container.md](container.md).

## Keys added but not visible in `zuul list`

Symptoms: `zuul add` succeeded on a workstation, you synced `~/.password-store/` to the bot host, but `zuul list` on the bot prints `no credentials stored under 'bot/'`. The `.gpg` files are clearly there in `~/.password-store/` — they're just not under the namespace `zuul list` is reading.

Cause: `zuul list` only shows entries under `~/.password-store/<namespace>/` (default `bot/`). If a sync put your credentials at the root of `~/.password-store/` instead of under `bot/`, they're invisible to zuul even though `pass ls` would show them.

Most common cause is an `rsync` / Syncthing rule that flattened the tree, or copying from a workstation where credentials were added with a different `ZUUL_NAMESPACE` than the bot is using.

Diagnose:

```bash
ls ~/.password-store/                             # what's actually there
ls ~/.password-store/bot/                         # what zuul list reads (default namespace)
echo "$ZUUL_NAMESPACE"                            # in case it's overridden
jq -r .namespace ~/.config/zuul/config.json       # what setup recorded
```

If you see `metabase.gpg` directly under `~/.password-store/` but nothing under `~/.password-store/bot/`, the entries went to the wrong place.

Fix: move the entries into the bot's namespace folder. They're already encrypted to the bot key, so this is just a file move — no re-encryption needed.

```bash
mkdir -p ~/.password-store/bot
mv ~/.password-store/*.gpg ~/.password-store/bot/
zuul list                                         # should now show them
```

If the recipient list under the namespace is wrong (`.gpg-id` lists a personal key the bot doesn't have), you'll get `gpg: <fpr>: skipped: No public key` on the next decrypt — see "No public key" below.

To prevent this recurring, fix the sync to preserve the directory structure (e.g. `rsync -a ~/.password-store/ bar:.password-store/` with the trailing slashes, not `rsync -a ~/.password-store/* bar:.password-store/`).

## Conflicts with existing GPG keys

`zuul setup` is non-destructive — it never deletes or overwrites a key. But it does need `gpg-agent` configured for unattended decryption, which can collide with an existing GPG workflow.

### Setup picks the wrong key

If you have multiple secret keys in your keyring, the personal-key picker lists all of them and lets you choose. Match the entry against `gpg --list-secret-keys` before confirming. If you've already run setup with the wrong key as the personal recipient, re-run `zuul setup` and pick again — `pass init` re-encrypts the store to the new recipient set on the spot.

### `pinentry-mode loopback` breaks your interactive GPG use

`zuul setup` appends three lines to `~/.gnupg/gpg.conf` and `~/.gnupg/gpg-agent.conf`:

```
pinentry-mode loopback        # gpg.conf
allow-loopback-pinentry       # gpg-agent.conf
default-cache-ttl 31536000    # gpg-agent.conf
max-cache-ttl    31536000     # gpg-agent.conf
```

These are required for unattended decryption: with loopback pinentry, gpg reads the passphrase from a file (`~/.bot-pass.txt`) instead of popping a UI dialog. The side effect is that interactive `gpg --decrypt` also stops showing a pinentry prompt, which can surprise users who relied on the GUI.

Two fixes:

1. **Run zuul under its own keyring.** Set `GNUPGHOME=~/.gnupg-zuul` in the shell that runs zuul (and in the boot-unlock hook). Zuul honours `GNUPGHOME`, and your daily-driver `~/.gnupg/` keeps its old config:

   ```bash
   export GNUPGHOME=~/.gnupg-zuul
   zuul setup
   ```

   Persist that variable wherever the bot process starts (shell rc file, systemd unit `Environment=`, container env).

2. **Keep the shared keyring but undo the loopback for interactive use.** Remove `pinentry-mode loopback` from `~/.gnupg/gpg.conf`; leave `allow-loopback-pinentry` in `gpg-agent.conf`. Zuul invokes gpg with `--pinentry-mode loopback` on the command line so it still works; your interactive `gpg` calls go back to using pinentry.

### Existing bot key on the host

If a previous zuul install (or a different machine) already created a bot key here, `zuul setup` will detect it and reuse it — no regeneration. If you want to start over, delete the old artifacts first:

```bash
FPR=$(jq -r .botKeyId ~/.config/zuul/config.json)
gpg --delete-secret-keys "$FPR"
gpg --delete-keys "$FPR"
rm -f ~/.bot-pass.txt
rm -rf ~/.config/zuul
zuul setup
```

This does **not** touch `~/.password-store/` — back it up first if it has data you want to keep, since the new bot key won't be able to decrypt the old entries.

### Personal key in a backup file, not in the keyring

The picker only lists keys gpg already knows about. Import the backup first, then run setup:

```bash
zuul import-key /path/to/my-key.asc
zuul setup           # the imported key now appears in the picker
```

## `gpg: <fpr>: skipped: No public key` on decrypt

The store's `.gpg-id` lists a recipient whose public key isn't in this machine's keyring — typically after a partial migration where the password store moved but the personal public key didn't.

Either bring the missing key over (`gpg --export <fpr>` on a machine that has it; `gpg --import` here), or re-init `pass` without it:

```bash
pass init <bot-fpr> [<your-personal-fpr>]
```

`pass init` re-encrypts every entry to the new recipient set, so it needs the *current* bot's secret key in the keyring to decrypt them first.

## `gpg: can't connect to the agent: IPC connect call failed`

Almost always a permissions problem on `~/.gnupg/`. It must be mode 700, owned by the running user, on a filesystem that supports unix sockets. The most common causes:

- UID mismatch between host and bind-mounted container volume (Docker passes ownership through unchanged).
- `~/.gnupg/` on `tmpfs` or a FUSE mount that doesn't allow unix sockets.
- A stale agent socket from a previous user; remove `~/.gnupg/S.gpg-agent*` and let gpg-agent recreate them.

```bash
chmod 700 ~/.gnupg
chown -R $(id -u):$(id -g) ~/.gnupg
gpgconf --kill gpg-agent      # forces a clean restart
```

## `zuul add` exits with code 4 ("command requires a TTY")

By design — `zuul add` refuses to take a password on the command line or read it from a pipe. If you're adding credentials from inside a running container or over `ssh`, allocate a TTY:

```bash
docker compose exec bot zuul add metabase     # `exec` allocates a TTY by default
ssh -t bar zuul add metabase                  # -t forces a TTY
```

For automated provisioning, add the credential on a workstation with a real terminal and sync the encrypted `~/.password-store/` to the bot — every entry is already encrypted to the bot key.

## `zuul get` exits with code 3 ("zuul not initialized")

`~/.config/zuul/config.json` is missing. Either `zuul setup` was never run on this host, or the config dir was wiped. If you have an export bundle, run `zuul import bundle.gpg`; otherwise `zuul setup` (or `zuul setup --bot-only` on a bot host).

## Migration- and container-specific issues

For migration-time problems (wrong transit passphrase, recipient mismatch on import, stale `.gpg-id` after import) see [host-migration.md § Troubleshooting](host-migration.md#troubleshooting).

For container-specific problems (UID mismatch, missing entrypoint unlock, healthcheck failures) see [container.md](container.md).
