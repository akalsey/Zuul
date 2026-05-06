# Migrating a Zuul bot host to a new machine

This guide covers moving a running bot's zuul setup — its identity, credentials, and configuration — to a new machine. Replacing hardware, swapping cloud providers, rebuilding a container image: same flow.

## What lives on a bot host

| What | Where (default) | Why it matters |
|---|---|---|
| Bot GPG key (secret + public) | `~/.gnupg/` | Decrypts everything in the password store. Losing it = losing the data. |
| Bot passphrase | `~/.bot-pass.txt` (mode 600) | Unlocks the secret key for unattended use. |
| Password store | `~/.password-store/` | The actual encrypted credentials. |
| Zuul config | `~/.config/zuul/config.json` | Records `botKeyId`, `humanKeyId`, `passphraseFile`, `namespace`. |

Migration moves all four. `zuul export --include-store` packages them into one encrypted bundle; `zuul import` unpacks it on the new host.

## The simple path

For a bot-only host (`zuul setup --bot-only`), there's no human key in the picture. Two commands per side:

```bash
# on the OLD host (Foo)
zuul export --include-store --out zuul-migration.gpg
# → prompts for a transit passphrase; type it twice
scp zuul-migration.gpg bar:

# on the NEW host (Bar) — gpg, pass, and a clean home
zuul import zuul-migration.gpg
# → prompts for the same transit passphrase
zuul doctor                       # all green = ready to use
shred -u zuul-migration.gpg       # wipe the transit copy
```

After import, `Bar` has the same bot key, passphrase file, password store, and namespace as `Foo`. The bot can decrypt every existing entry.

## Pre-flight checklist

Before running `zuul import` on the destination:

- [ ] `gpg` and `pass` are installed (`zuul setup` printed install hints when you ran it the first time; same hints work here).
- [ ] The user account that will run zuul exists and has the **same UID** as on the source. UID mismatches on a bind-mounted home show up as `gpg: can't connect to the agent: IPC connect call failed`.
- [ ] `~/.gnupg`, `~/.password-store`, `~/.config/zuul`, and `~/.bot-pass.txt` are absent (or you're prepared to overwrite them — `zuul import` refuses to clobber a populated store without `--force` or interactive confirmation).
- [ ] You have the transit passphrase you typed at export time. There's no recovery — losing it means re-exporting on the source.

## Containers

The flow is the same shape, just plumbed through Docker secrets. Stage the bundle and its transit passphrase on the container host:

```bash
sudo install -d -m 700 -o 1000 -g 1000 /opt/zuul-secrets
sudo install -m 600 -o 1000 -g 1000 zuul-migration.gpg /opt/zuul-secrets/zuul-export
printf '%s' "$TRANSIT_PASS" | sudo tee /opt/zuul-secrets/zuul-export-pass >/dev/null
sudo chown 1000:1000 /opt/zuul-secrets/zuul-export-pass
sudo chmod 600 /opt/zuul-secrets/zuul-export-pass
```

Bind-mount `/opt/zuul-secrets` at `/run/secrets` and let the entrypoint run `zuul import` with no arguments — it auto-detects `/run/secrets/zuul-export` (bundle) and `/run/secrets/zuul-export-pass` (passphrase). Compose / BuildKit examples are in [container.md](container.md).

After the first successful start, the bind mount is redundant. Either drop it or leave it `:ro` for re-import safety. Rotate the transit passphrase off `/opt/zuul-secrets/zuul-export-pass` either way.

## Migrating a workstation host

If the host being moved is a *workstation* — bot key + a personal key + your daily-driver password store — the bundle still won't carry the personal key, by design. Zuul doesn't manage your personal GPG identity; it just records the fingerprint and uses the key as a `pass` recipient.

The order matters:

1. **On the source:** `zuul export --include-store --out migration.gpg`.
2. **Move your personal GPG key to the destination** — see [personal-key-migration.md](personal-key-migration.md). This is a `gpg --export-secret-keys` / `gpg --import` flow, not a zuul one.
3. **On the destination:** `zuul import migration.gpg`.
4. `zuul doctor`.

Skipping step 2 leaves the imported `.gpg-id` referencing a personal-key fingerprint whose public key isn't in the destination's keyring. The next `zuul add` fails with `gpg: <fpr>: skipped: No public key`. Either complete step 2, or re-run `zuul setup` to drop the old recipient and add a new personal key (which re-encrypts the imported store).

## Verification

```bash
zuul doctor                          # all checks green
zuul list                            # entries from the source show up
zuul get <known-entry>               # decrypts without a prompt
```

`zuul doctor` will flag `boot-time unlock not installed` on a fresh destination. That's expected — boot-unlock hooks (launchd / systemd-user) aren't bundle contents and have to be set up per-machine. Run `zuul setup` to install them, or follow the entrypoint pattern in [container.md](container.md) for containers.

## Decommissioning the old host

Once the new host is verified end-to-end:

```bash
# on Foo (the old host)
FPR=$(jq -r .botKeyId ~/.config/zuul/config.json)
gpg --delete-secret-keys "$FPR"
gpg --delete-keys "$FPR"
shred -u ~/.bot-pass.txt
rm -rf ~/.password-store ~/.config/zuul
```

If the host is being wiped or returned, that's moot — but on a repurposed host, run these so the bot key doesn't linger.

## Troubleshooting

**`failed to decrypt bundle (wrong transit passphrase?)`** — exactly that. Try again, or re-export from the source.

**`refusing to replace existing bot key non-interactively`** — the destination has a different `botKeyId` already configured. Run interactively to confirm, pass `--force`, or import onto a fresh home.

**`refusing to leave pass store with a stale recipient list`** (or its interactive equivalent: `<file> does not list the imported bot key`) — the destination's existing `pass` store was init'd with a different bot key. Re-init pass with the imported key as a recipient. `zuul import` will offer to do this automatically when run interactively; non-interactive runs error out with the exact `pass init` command to run by hand.

**`gpg: <fpr>: skipped: No public key`** when running `zuul add` after migration — the imported store's `.gpg-id` lists a recipient whose public key isn't in this machine's keyring. Bring the missing public key over (`gpg --export <fpr>` on a machine that has it; `gpg --import` here), or re-init pass without it: `pass init <bot-fpr> [<your-personal-fpr>]`.

**`gpg: can't connect to the agent: IPC connect call failed`** — almost always a permissions issue on `~/.gnupg/`. Should be mode 700, owned by the running user, on a filesystem that supports unix sockets. UID mismatches between the host and a bind-mounted container volume are the most common cause; `tmpfs` or some FUSE filesystems are second.
