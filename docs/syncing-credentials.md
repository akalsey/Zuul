# Syncing credentials from a workstation to a bot host

Gatepass intentionally does not sync the password store. Once a workstation is paired to a bot host (both have the bot key — see [host-migration.md](host-migration.md) for the pairing flow), it's your call how the encrypted entries get from one to the other. This doc lists the three transports that come up most often.

## What's being synced

```
~/.password-store/
├── .gpg-id          # list of recipient fingerprints (text, not secret)
├── bot/             # default ZUUL_NAMESPACE — the entries gatepass list shows
│   ├── metabase.gpg
│   └── ...
└── ...
```

Every `.gpg` file is encrypted to the bot key (and to your personal key, if you have one configured), so the contents are safe over any transport. What matters is that the **directory layout is preserved on the bot host** — `bot/metabase.gpg` must land at `~/.password-store/bot/metabase.gpg`, not at `~/.password-store/metabase.gpg`. If the namespace gets flattened, `gatepass list` reports nothing even though the files are there.

## Don't write from two places at once

`pass insert` (which `gatepass add` calls) is not designed for concurrent writes from multiple hosts. Pick one machine — usually the workstation — as the canonical writer, and have the bot host receive only. If the bot host ever runs `gatepass add` interactively, sync the bot's store back to the workstation before you add anything else there.

## rsync

The default choice for one-shot and cron-driven syncs:

```bash
rsync -a --delete ~/.password-store/ bar:.password-store/
```

- The trailing slashes matter. `~/.password-store/` (with slash) copies the *contents* into the destination; without it, rsync nests the directory one level deeper.
- `--delete` mirrors deletions. Drop it if you want additive-only sync.
- Use `rsync -avn ...` first to preview.

A typical cron line on the workstation, every 5 minutes:

```
*/5 * * * * rsync -a --delete $HOME/.password-store/ bar:.password-store/ >/dev/null 2>&1
```

## scp

Fine for one-off transfers (initial seeding, ad-hoc fixes); not great as an ongoing sync because it doesn't track deletions or do incremental transfer:

```bash
scp -r ~/.password-store/. bar:.password-store/
```

The `/.` ensures hidden files (notably `.gpg-id`) come along.

## Syncthing

For continuous, two-way replication without cron:

1. Install Syncthing on both hosts.
2. On the workstation, share `~/.password-store` as a folder. Set folder type to **Send Only** so the bot can never push changes back.
3. On the bot host, accept the share into `~/.password-store`.
4. Add `.stignore` if you want to exclude anything; for a vanilla gatepass setup you don't need to.

Syncthing handles deletes, partial transfers, and reconnection on its own, which makes it a good fit for laptops that aren't always online.

## Verify on the bot

After any of the above:

```bash
ssh bar gatepass list
ssh bar gatepass doctor
```

`gatepass list` should show every entry you added on the workstation. If it shows nothing but the `.gpg` files are present, you almost certainly flattened the namespace — see [troubleshooting.md](troubleshooting.md).
