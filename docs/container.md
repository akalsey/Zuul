# Running Gatepass in a container

Gatepass was designed for a long-lived host (your laptop, a VM, a bare-metal bot box) where `gpg-agent` keeps the bot key unlocked across reboots. Containers break two of those assumptions:

- There is no init system (no `launchd`, usually no `systemd --user`), so the boot-time unlock hooks `gatepass setup` would normally install have nowhere to land.
- The container filesystem is ephemeral. Anything Gatepass writes to `$HOME` is gone the moment the container exits unless you mount a volume over it.

This guide covers what to persist, where to mount it, three ways to provision the bot key, and how to replace boot-time unlock with an entrypoint.

The examples target the same image the reference bot uses: `node:22-bookworm-slim`. Other Debian/Ubuntu-based slim images work the same way; for Alpine see the note at the bottom.

## What Gatepass writes to disk

Four locations matter. All of them default to paths under `$HOME`, so they all need to either be on a persistent volume or be re-created at container start.

| Path | Contents | Persist? |
|---|---|---|
| `~/.gnupg/` | GPG keyring, `gpg.conf`, `gpg-agent.conf`, agent sockets | **yes** — losing this loses the bot key |
| `~/.password-store/` | Encrypted credential files (`pass` storage) | **yes** — this is your data |
| `~/.config/gatepass/config.json` | Bot fingerprint, passphrase-file path, namespace | **yes** — small but required |
| `~/.bot-pass.txt` | Bot key passphrase, mode 600 | **yes** — without it the bot can't unlock its own key |

The agent socket inside `~/.gnupg/` is recreated by `gpg-agent` on each start, so it's safe to keep the whole directory on a volume.

The actual paths are configurable:

| Variable | Default | What it moves |
|---|---|---|
| `GNUPGHOME` | `~/.gnupg` | The keyring + agent config |
| `PASSWORD_STORE_DIR` | `~/.password-store` | The `pass` store |
| `ZUUL_CONFIG_DIR` | `~/.config/gatepass` | `config.json` |
| `ZUUL_NAMESPACE` | `bot` | Subdirectory inside the password store |

The bot passphrase file path is recorded inside `config.json` (`passphraseFile`); set it explicitly during setup (or edit `config.json`) if you want it somewhere other than `~/.bot-pass.txt`.

## Recommended layout

Put everything Gatepass owns under a single directory and mount that as a volume. This is simpler than juggling four bind mounts and makes backups trivial.

```
/home/node/
├── .bot-pass.txt
├── .config/gatepass/config.json
├── .gnupg/
└── .password-store/
```

A single named volume mounted at `/home/node/` covers all of it. (`node:22-bookworm-slim` ships an unprivileged `node` user at UID 1000; adjust the path if your image uses a different home directory.)

## Installing the runtime dependencies

`node:22-bookworm-slim` does not ship with `gpg` or `pass`. Add them in your Dockerfile:

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      gnupg \
      pass \
    && rm -rf /var/lib/apt/lists/*

# Gatepass itself
RUN npm install -g https://github.com/akalsey/Gatepass.git

USER node
WORKDIR /home/node

ENTRYPOINT ["/usr/local/bin/gatepass-entrypoint.sh"]
CMD ["node", "your-bot.js"]
```

You do **not** need `pinentry`, `dbus`, `systemd`, or any desktop GPG packages. Gatepass configures `gpg-agent` for loopback pinentry, which reads the passphrase straight from `~/.bot-pass.txt` — no UI prompt is ever produced.

## Provisioning the bot key

A container should **never** generate a fresh bot key — fresh keys live on whoever generated them, which means losing the container's filesystem loses the key, and the encrypted password store with it. Always import a pre-existing bot key. Gatepass supports three ways to feed that key into a container, with different security and operational tradeoffs.

| Pattern | Key + passphrase end up in image layer? | Image is sensitive? | Rotation cost | Best for |
|---|---|---|---|---|
| **A. Bind-mounted secrets dir** (recommended) | No | No | Swap a file, restart | Most production deployments |
| **B. Docker / Compose secrets** (`/run/secrets/*`) | No | No | `docker secret rm` + recreate | Swarm / Compose stacks |
| **C. BuildKit secret + import at build** | Yes (intentionally) | Yes — treat as secret | Rebuild + redeploy image | Self-contained appliance images for private registries |

All three converge on the same end state: `~/.gnupg/`, `~/.bot-pass.txt`, and `~/.config/gatepass/config.json` populated inside the container's home directory. They differ in *when* and *how* the key gets there.

Across all patterns, the bot key + passphrase you feed in have to be generated somewhere first. Run `gatepass setup --bot-only` on a workstation, then produce an encrypted bundle with `gatepass export` (recommended) or two raw files. The patterns below show both forms.

```bash
# encrypted bundle (one file, passphrase-protected)
gatepass export --out gatepass-bot.gpg
echo "$TRANSIT_PASS" > gatepass-bot-pass.txt   # save the passphrase you typed

# OR raw files
gpg --export-secret-keys "$(jq -r .botKeyId ~/.config/gatepass/config.json)" > bot-key.asc
cp ~/.bot-pass.txt bot-pass.txt
```

Use the bundle when the key needs to live in source control, on shared storage, or anywhere else that benefits from encryption at rest. Use raw files when you'd rather not deal with a transit passphrase and the channel is already trusted (e.g. Docker secrets at rest).

### Pattern A — Bind-mounted secrets dir (recommended)

Stage the key + passphrase on the host as read-only files owned by the container user, bind-mount that directory into the container, and let an entrypoint script import on first start.

**Stage on the host:**
```bash
sudo install -d -m 700 -o 1000 -g 1000 /opt/gatepass-secrets
sudo install -m 600 -o 1000 -g 1000 bot-key.asc  /opt/gatepass-secrets/gatepass-bot-key
sudo install -m 600 -o 1000 -g 1000 bot-pass.txt /opt/gatepass-secrets/gatepass-bot-pass
```

The `-o 1000 -g 1000` matches the `node` user inside `node:22-bookworm-slim`. Mismatched UIDs is the #1 cause of "permission denied" headaches with bind mounts — Docker passes host ownership through unchanged.

**Compose:**
```yaml
services:
  bot:
    image: my-bot:latest
    user: "1000:1000"
    volumes:
      - gatepass-data:/home/node                       # persistent state
      - /opt/gatepass-secrets:/run/secrets:ro          # bootstrap key + passphrase
    restart: unless-stopped

volumes:
  gatepass-data:
```

**Entrypoint (`/usr/local/bin/gatepass-entrypoint.sh`):**
```sh
#!/bin/sh
set -e

if [ ! -f "$HOME/.config/gatepass/config.json" ]; then
  # Either form works; pick whichever matches what you staged on the host.
  if [ -f /run/secrets/gatepass-export ]; then
    gatepass import                      # auto-detects /run/secrets/gatepass-export
                                     # and          /run/secrets/gatepass-export-pass
  else
    gatepass import-key --as-bot         # auto-detects /run/secrets/gatepass-bot-key
                                     # and          /run/secrets/gatepass-bot-pass
  fi
fi

gatepass unlock
exec "$@"
```

After first start, the import has copied the key into `~/.gnupg/` and the passphrase into `~/.bot-pass.txt`, both of which live in the `gatepass-data` volume. The bind mount is now redundant — keep it `:ro` for defense-in-depth re-import, or remove it entirely once provisioning is confirmed.

**Tradeoffs:**
- **Pro:** image is generic, non-sensitive, can be pushed to a public registry without leaking anything.
- **Pro:** key rotation is "swap file + restart" — no rebuild.
- **Pro:** the same image can serve multiple hosts each holding different bot keys.
- **Con:** every host needs the secret staged on it before the container can start the first time.
- **Con:** you have to be careful about UID alignment between host and container.

### Pattern B — Docker / Compose secrets

If you're already using Docker Compose secrets or Swarm, use the native mechanism. Compose mounts secrets into `/run/secrets/<name>` automatically with `0444` permissions and ownership matching the container user, so no `chown` dance is required.

**Compose:**
```yaml
services:
  bot:
    image: my-bot:latest
    user: "1000:1000"
    volumes:
      - gatepass-data:/home/node
    secrets:
      - gatepass-bot-key
      - gatepass-bot-pass
    restart: unless-stopped

secrets:
  gatepass-bot-key:
    file: ./bot-key.asc
  gatepass-bot-pass:
    file: ./bot-pass.txt

volumes:
  gatepass-data:
```

The same entrypoint as Pattern A works unchanged — `gatepass import-key --as-bot` auto-detects `/run/secrets/gatepass-bot-key` and `/run/secrets/gatepass-bot-pass`.

**Tradeoffs:**
- **Pro:** ownership/permissions handled automatically; no host-side `chown`.
- **Pro:** secrets are managed alongside the rest of the Compose/Swarm stack.
- **Pro:** image stays generic and non-sensitive.
- **Con:** raw `docker run` doesn't support `--secret` for runtime; this pattern is Compose- or Swarm-specific.

### Pattern C — BuildKit secret, import at build time

If you specifically want a self-contained image you can ship to a private registry and run anywhere with no host-side provisioning, you can do the import at build time. BuildKit's `--mount=type=secret` lets you feed the key file into a single `RUN` step without it landing in the image layer — but **the imported key and passphrase do persist** in `~/.gnupg/` and `~/.bot-pass.txt` afterwards, which is the whole point.

**Dockerfile:**
```dockerfile
# syntax=docker/dockerfile:1.4
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends gnupg pass \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g https://github.com/akalsey/Gatepass.git

USER node
WORKDIR /home/node

RUN --mount=type=secret,id=bot-key,target=/tmp/bot-key.asc,uid=1000 \
    --mount=type=secret,id=bot-pass,target=/tmp/bot-pass,uid=1000 \
    gatepass import-key /tmp/bot-key.asc --as-bot --passphrase-file /tmp/bot-pass

COPY --chown=node:node gatepass-entrypoint.sh /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/gatepass-entrypoint.sh"]
CMD ["node", "your-bot.js"]
```

**Build:**
```bash
docker build \
  --secret id=bot-key,src=./bot-key.asc \
  --secret id=bot-pass,src=./bot-pass.txt \
  -t my-bot .
```

The `/tmp` mounts are unmounted when the `RUN` ends and never enter a layer. But everything `gatepass import-key` writes — `~/.gnupg/`, `~/.bot-pass.txt`, `~/.config/gatepass/config.json` — is now baked in.

The entrypoint reduces to just `gatepass unlock; exec "$@"` since first-run import already happened at build time. The `~/.password-store/` still belongs in a runtime volume because that's where credentials are added and updated.

**Tradeoffs:**
- **Pro:** image is fully self-contained — `docker run my-bot` works on any host with no provisioning.
- **Pro:** good fit for immutable-infrastructure / appliance deployments.
- **Con:** image is a secret — anyone with pull access can decrypt anything encrypted to that bot key. Push only to private registries.
- **Con:** key rotation = rebuild + redeploy. Old image tags hold the old key forever.
- **Con:** every environment that runs the same image shares the same bot key.
- **Con:** image scanners and SBOM tools may flag the embedded secret material.

## Boot-time unlock — use an entrypoint

The systemd path inside `gatepass setup` won't work in a container (no user session, no `systemctl --user`). The supported pattern is to call `gatepass unlock` from your container entrypoint, before the bot process starts.

```sh
#!/bin/sh
set -e

if [ ! -f "$HOME/.config/gatepass/config.json" ]; then
  gatepass import-key --as-bot
fi

gatepass unlock
exec "$@"
```

Why this works: `gatepass unlock` reads `~/.bot-pass.txt` and asks `gpg-agent` to cache the bot key. Setup writes a very long cache TTL (`default-cache-ttl 31536000`, one year), so the key stays unlocked for the lifetime of the container — which, for a long-running bot, is exactly the same lifetime guarantee `launchd`/`systemd` give on a real host.

You can skip the explicit `gatepass unlock`: the first `gatepass get` will lazily start `gpg-agent` and unlock the key the same way. The downside is one slow first call and a worse error if `~/.bot-pass.txt` is missing. The entrypoint pattern fails fast at container start, which is the better failure mode.

If you happen to run `gatepass setup` interactively inside a container (for example, to bootstrap a volume before going to production), answer **no** to its boot-unlock prompt — it will try to invoke `systemctl --user` and fail.

## Adding credentials from a running container

`gatepass add` requires a TTY and refuses to take the password on the command line. To add secrets from inside a running container:

```bash
docker compose exec bot gatepass add metabase
```

Most teams add credentials from a workstation where setup happened and let the encrypted password store sync into the container's volume (Syncthing, `rsync`, a sidecar that pulls from git, etc.) — anything `gatepass add` writes is already encrypted to the bot's recipient.

## Permissions and ownership

A few things will silently break if the volume's ownership is wrong:

- `~/.gnupg/` must be mode 700 and owned by the running user, or `gpg-agent` refuses to start.
- `~/.bot-pass.txt` must be mode 600. Gatepass writes it that way; preserve the mode when you copy it into the volume.
- The container user (UID 1000 for `node:22-bookworm-slim`) must own everything under `/home/node/`. If you bind-mount from the host, match the UIDs or run a one-shot `chown` container first.

If you see `gpg: can't connect to the agent: IPC connect call failed` after restart, it's almost always a permissions problem on `~/.gnupg/` or its parent.

## Health check

A cheap healthcheck that proves the bot key is unlocked and the store is readable:

```dockerfile
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD gatepass list >/dev/null 2>&1 || exit 1
```

`gatepass list` only enumerates filenames, so it costs nothing and doesn't decrypt anything, but it does require config + password store to be present and accessible.

## Alpine note

If you're on `node:22-alpine` instead, install `gnupg pass bash` (busybox `sh` is fine for the entrypoint, but `pass` invokes `bash` internally). The Alpine `gnupg` package uses the same loopback-pinentry flow Gatepass configures.

## Generating the bot key in the first place

All three patterns above assume you already have either a `gatepass-export` bundle or a `bot-key.asc` + `bot-pass.txt` pair to feed in. Generate the bot key on a workstation (any machine with a TTY and `/dev/urandom`), then choose a transit form:

```bash
gatepass setup --bot-only

# encrypted bundle (recommended) — one file, passphrase-protected
gatepass export --out gatepass-bot.gpg
# remember the transit passphrase you typed — you'll need it on the destination

# OR raw files
gpg --export-secret-keys "$(jq -r .botKeyId ~/.config/gatepass/config.json)" > bot-key.asc
cp ~/.bot-pass.txt bot-pass.txt
```

Treat the resulting file(s) as you would any other long-lived secret: 600 permissions, encrypted at rest, no checking them into git. The bundle is symmetrically encrypted with AES-256 so it's safer to copy across less-trusted channels, but it still needs the transit passphrase on the destination. From here, pick the pattern above that matches your deployment model.
