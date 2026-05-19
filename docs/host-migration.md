# Migrating a Gatepass bot host to a new machine

This guide covers moving a running bot's gatepass setup — its identity, credentials, and configuration — to a new machine. Replacing hardware, swapping cloud providers, rebuilding a container image: same flow.

## What lives on a bot host

| What | Where (default) | Why it matters |
|---|---|---|
| Bot GPG key (secret + public) | `~/.gnupg/` | Decrypts everything in the password store. Losing it = losing the data. |
| Bot passphrase | `~/.bot-pass.txt` (mode 600) | Unlocks the secret key for unattended use. |
| Password store | `~/.password-store/` | The actual encrypted credentials. |
| Gatepass config | `~/.config/gatepass/config.json` | Records `botKeyId`, `humanKeyId`, `passphraseFile`, `namespace`. |

Migration moves all four. `gatepass export --include-store` packages them into one encrypted bundle; `gatepass import` unpacks it on the new host.

## The simple path

For a bot-only host (`gatepass setup --bot-only`), there's no human key in the picture. Two commands per side:

```bash
# on the OLD host (Foo)
gatepass export --include-store --out gatepass-migration.gpg
# → prompts for a transit passphrase; type it twice
scp gatepass-migration.gpg bar:

# on the NEW host (Bar) — gpg, pass, and a clean home
gatepass import gatepass-migration.gpg
# → prompts for the same transit passphrase
gatepass doctor                       # all green = ready to use
shred -u gatepass-migration.gpg       # wipe the transit copy
```

After import, `Bar` has the same bot key, passphrase file, password store, and namespace as `Foo`. The bot can decrypt every existing entry.

## Pre-flight checklist

Before running `gatepass import` on the destination:

- [ ] `gpg` and `pass` are installed (`gatepass setup` printed install hints when you ran it the first time; same hints work here).
- [ ] The user account that will run gatepass exists and has the **same UID** as on the source. UID mismatches on a bind-mounted home show up as `gpg: can't connect to the agent: IPC connect call failed`.
- [ ] `~/.gnupg`, `~/.password-store`, `~/.config/gatepass`, and `~/.bot-pass.txt` are absent (or you're prepared to overwrite them — `gatepass import` refuses to clobber a populated store without `--force` or interactive confirmation).
- [ ] You have the transit passphrase you typed at export time. There's no recovery — losing it means re-exporting on the source.

## Containers

The flow is the same shape, just plumbed through Docker secrets. Stage the bundle and its transit passphrase on the container host:

```bash
sudo install -d -m 700 -o 1000 -g 1000 /opt/gatepass-secrets
sudo install -m 600 -o 1000 -g 1000 gatepass-migration.gpg /opt/gatepass-secrets/gatepass-export
printf '%s' "$TRANSIT_PASS" | sudo tee /opt/gatepass-secrets/gatepass-export-pass >/dev/null
sudo chown 1000:1000 /opt/gatepass-secrets/gatepass-export-pass
sudo chmod 600 /opt/gatepass-secrets/gatepass-export-pass
```

Bind-mount `/opt/gatepass-secrets` at `/run/secrets` and let the entrypoint run `gatepass import` with no arguments — it auto-detects `/run/secrets/gatepass-export` (bundle) and `/run/secrets/gatepass-export-pass` (passphrase). Compose / BuildKit examples are in [container.md](container.md).

After the first successful start, the bind mount is redundant. Either drop it or leave it `:ro` for re-import safety. Rotate the transit passphrase off `/opt/gatepass-secrets/gatepass-export-pass` either way.

## Migrating a workstation host

If the host being moved is a *workstation* — bot key + a personal key + your daily-driver password store — the bundle still won't carry the personal key, by design. Gatepass doesn't manage your personal GPG identity; it just records the fingerprint and uses the key as a `pass` recipient.

The order matters:

1. **On the source:** `gatepass export --include-store --out migration.gpg`.
2. **Move your personal GPG key to the destination** — see [personal-key-migration.md](personal-key-migration.md). This is a `gpg --export-secret-keys` / `gpg --import` flow, not a gatepass one.
3. **On the destination:** `gatepass import migration.gpg`.
4. `gatepass doctor`.

Skipping step 2 leaves the imported `.gpg-id` referencing a personal-key fingerprint whose public key isn't in the destination's keyring. The next `gatepass add` fails with `gpg: <fpr>: skipped: No public key`. Either complete step 2, or re-run `gatepass setup` to drop the old recipient and add a new personal key (which re-encrypts the imported store).

## Re-running `gatepass setup` after import

Whether you need to run `gatepass setup` after `gatepass import` depends on what was in the bundle and what the destination needs:

| Scenario | Run `gatepass setup` after import? |
|---|---|
| **Host migration** with `--include-store` (bundle had the password store) | No — import alone reconstitutes a working install. Run `gatepass doctor` to confirm. |
| **Host migration** with `--include-store` onto a host that *also* needs a personal key | Yes — `gatepass setup` is what adds the personal key to the recipient list. |
| **Workstation pairing** (no `--include-store`) | Yes — the laptop has no personal key and no `pass init` yet. |

When `gatepass setup` runs after `gatepass import`:

- **Bot key step is skipped automatically.** Setup notices that `cfg.botKeyId` is in the keyring and the passphrase file exists, prints `✓ reusing existing bot key <id>`, and moves on. No prompts about the bot key.
- **Personal key picker still runs.** Pick an existing key or generate a new one — that's what setup is for.
- **`pass init` runs again** with the chosen recipients (bot + personal). If a password store already exists (e.g. you imported with `--include-store`), this re-encrypts every entry to the new recipient set. The bot key from the bundle stays a recipient; the local personal key is added.
- **Boot-time unlock prompt** runs again — answer no if you already have one installed.

**Recipient mismatch.** If you import a *new* bot key on top of a machine where `pass` was already initialized with a *different* bot key (a key rotation, or swapping which bot a workstation pairs with), `~/.password-store/<namespace>/.gpg-id` still lists the old bot. New entries written there would not be readable by the bot you just imported. `gatepass import` detects this:

- **Interactive:** warns and offers to re-init `pass` with the imported bot key + the existing personal key (default yes). Re-init re-encrypts every entry on the spot — it needs the *old* bot's secret key in the keyring to decrypt them first, so don't `gpg --delete-secret-key` the old bot until after the re-init.
- **Non-interactive** (no TTY): refuses with exit 1 and tells you the exact `pass init` command to run, or to re-run `gatepass import` interactively. Containers should always be importing onto a fresh volume, where this case doesn't arise.

## Verification

```bash
gatepass doctor                          # all checks green
gatepass list                            # entries from the source show up
gatepass get <known-entry>               # decrypts without a prompt
```

`gatepass doctor` will flag `boot-time unlock not installed` on a fresh destination. That's expected — boot-unlock hooks (launchd / systemd-user) aren't bundle contents and have to be set up per-machine. Run `gatepass setup` to install them, or follow the entrypoint pattern in [container.md](container.md) for containers.

## Decommissioning the old host

Once the new host is verified end-to-end:

```bash
# on Foo (the old host)
FPR=$(jq -r .botKeyId ~/.config/gatepass/config.json)
gpg --delete-secret-keys "$FPR"
gpg --delete-keys "$FPR"
shred -u ~/.bot-pass.txt
rm -rf ~/.password-store ~/.config/gatepass
```

If the host is being wiped or returned, that's moot — but on a repurposed host, run these so the bot key doesn't linger.

## Troubleshooting

**`failed to decrypt bundle (wrong transit passphrase?)`** — exactly that. Try again, or re-export from the source.

**`refusing to replace existing bot key non-interactively`** — the destination has a different `botKeyId` already configured. Run interactively to confirm, pass `--force`, or import onto a fresh home.

**`refusing to leave pass store with a stale recipient list`** (or its interactive equivalent: `<file> does not list the imported bot key`) — the destination's existing `pass` store was init'd with a different bot key. Re-init pass with the imported key as a recipient. `gatepass import` will offer to do this automatically when run interactively; non-interactive runs error out with the exact `pass init` command to run by hand.

**`gpg: <fpr>: skipped: No public key`** when running `gatepass add` after migration — the imported store's `.gpg-id` lists a recipient whose public key isn't in this machine's keyring. Bring the missing public key over (`gpg --export <fpr>` on a machine that has it; `gpg --import` here), or re-init pass without it: `pass init <bot-fpr> [<your-personal-fpr>]`.

**`gpg: can't connect to the agent: IPC connect call failed`** — almost always a permissions issue on `~/.gnupg/`. Should be mode 700, owned by the running user, on a filesystem that supports unix sockets. UID mismatches between the host and a bind-mounted container volume are the most common cause; `tmpfs` or some FUSE filesystems are second.
