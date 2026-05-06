# Moving a personal GPG key to a new workstation

Zuul doesn't manage your personal GPG key. It records the key's fingerprint (`humanKeyId` in `~/.config/zuul/config.json`) and uses the key as a `pass` recipient, but generating it, moving it across machines, and trusting it is something you do with `gpg` directly — exactly the same way you would for signed git commits, encrypted email, or any other GPG-consuming tool.

This guide is the GPG-side companion to a zuul migration. Do these steps first; *then* run `zuul import` (or `zuul setup`) on the new workstation.

## When you need this

- **Replacing a workstation** — old laptop dying, new laptop arriving. Both should map to the same identity.
- **Adding a second workstation** — keep one personal key but use it from both a desktop and a laptop.
- **Restoring from backup** — you have an encrypted personal-key backup somewhere and want to drop it on a fresh machine.

You **don't** need this when:

- Setting up a brand-new personal identity — just run `zuul setup` on the new machine and let it generate a new personal key.
- Setting up a bot host (`zuul setup --bot-only`) — bot hosts have no personal key.

## Export from the source machine

```bash
# 1. find the fingerprint
gpg --list-secret-keys

# 2. export the secret key (this also includes the public key)
FPR=<your-fingerprint>
gpg --export-secret-keys --armor "$FPR" > my-key.asc

# 3. export your ownertrust DB (so the destination knows you trust this key ultimately)
gpg --export-ownertrust > my-trust.txt
```

Move both files to the destination over a trusted channel — `scp` over SSH, a hardware token, an encrypted external drive. The `.asc` file is still protected by the key's own passphrase (if you set one), but that's no excuse to leave it sitting in a Slack DM. Treat it like any other long-lived secret.

## Import on the destination machine

```bash
gpg --import my-key.asc
gpg --import-ownertrust my-trust.txt

# verify
gpg --list-secret-keys "$FPR"      # should show [SC] / [E] capability flags
echo zuul | gpg --clearsign --local-user "$FPR" >/dev/null   # signing works without an "untrusted" prompt

shred -u my-key.asc my-trust.txt    # wipe transit copies
```

## Why the trust step matters

`gpg --import` puts the secret key in your keyring but leaves the matching public key at *unknown* ownertrust on the new machine. Encrypting to an unknown-trust key under `--batch` (which `pass insert` uses) refuses without an interactive `Use this key anyway? (y/N)` answer — and there's nobody to type `y`.

`gpg --import-ownertrust` fixes this in one shot. If you forgot to export the trust DB on the source side, you can set it directly:

```bash
echo "$FPR:6:" | gpg --import-ownertrust    # 6 = ultimate
```

(This is the same gotcha `zuul import-key --as-bot` works around automatically for the bot key. For a personal key, you do it yourself.)

## After your personal key is in place

The new machine now has the same personal identity as the source. From here:

- **Already have a `zuul export` bundle for this machine?** Run `zuul import bundle.gpg`. If the bundle includes the password store (`--include-store`), the restored `.gpg-id` will list your now-imported personal key as a recipient and `zuul add` will work immediately. `zuul doctor` should come up green.
- **Don't have a bundle?** Run `zuul setup`. The wizard will list your imported personal key in the picker — choose it, and pass will be initialized with bot + personal as recipients.

The order matters: import the personal key **before** `zuul import` if the bundle has a password store, so the recipient is already present when `pass` tries to round-trip the entries.

## Sharing one personal key across multiple active workstations

The export/import flow above gives both machines the same secret key. Pass entries added on either are decryptable on both. The downside is blast radius — a compromise of either machine compromises the identity.

If you'd rather isolate per-machine identities, generate a separate personal key on each workstation and add every workstation's personal key as an additional `pass` recipient:

```bash
# on workstation 2, after running zuul setup (which generated ws2's own personal key):
cd ~/.password-store
pass init "$(jq -r .botKeyId ~/.config/zuul/config.json)" <ws1-personal-fpr> <ws2-personal-fpr>
```

Each workstation's personal key decrypts only what it added (plus the bot's contributions). The bot still decrypts everything. Either workstation can read what the other wrote because both keys are recipients.

This is more setup, more keys to track, and reduces the workflow above to "make a fresh personal key on every machine" — but it's the right answer if you can't have a single key on more than one machine.

## What to do with the export files

The `.asc` and `.txt` files are full-fidelity copies of your private identity:

- **Never** commit them to git, paste them into a chat tool, or leave them in `~/Downloads`.
- **Always** `shred -u` immediately after the import succeeds, or stash them in a hardware-backed password manager if you want a long-term backup.
- If transit went through anything that may have logged the file (mail, cloud storage, a CI runner), assume the key is compromised and rotate it.

## What zuul does and doesn't do here

To be explicit about the line:

- Zuul **records** your personal key's fingerprint and uses it as a `pass` recipient.
- Zuul **doesn't move, generate, or back up** your personal key — that's `gpg`'s job (or yours).
- Zuul **doesn't include** your personal key in `zuul export` bundles. The bundle carries the bot key only. Move the personal key with this guide first, then run `zuul import`.
- `zuul setup` will offer to generate a personal key only if you have no GPG secret keys at all. It never overwrites or alters an existing personal key.
