# Running Zuul in a container

Zuul was designed for a long-lived host (your laptop, a VM, a bare-metal bot box) where `gpg-agent` keeps the bot key unlocked across reboots. Containers break two of those assumptions:

- There is no init system (no `launchd`, usually no `systemd --user`), so the boot-time unlock hooks `zuul setup` would normally install have nowhere to land.
- The container filesystem is ephemeral. Anything Zuul writes to `$HOME` is gone the moment the container exits unless you mount a volume over it.

This guide covers what to persist, where to mount it, how to handle setup, and how to replace boot-time unlock with an entrypoint.

The examples target the same image the reference bot uses: `node:22-bookworm-slim`. Other Debian/Ubuntu-based slim images work the same way; for Alpine see the note at the bottom.

## What Zuul writes to disk

Four locations matter. All of them default to paths under `$HOME`, so they all need to either be on a persistent volume or be re-created at container start.

| Path | Contents | Persist? |
|---|---|---|
| `~/.gnupg/` | GPG keyring, `gpg.conf`, `gpg-agent.conf`, agent sockets | **yes** — losing this loses the bot key |
| `~/.password-store/` | Encrypted credential files (`pass` storage) | **yes** — this is your data |
| `~/.config/zuul/config.json` | Bot fingerprint, passphrase-file path, namespace | **yes** — small but required |
| `~/.bot-pass.txt` | Bot key passphrase, mode 600 | **yes** — without it the bot can't unlock its own key |

The agent socket inside `~/.gnupg/` is recreated by `gpg-agent` on each start, so it's safe to keep the whole directory on a volume.

The actual paths are configurable:

| Variable | Default | What it moves |
|---|---|---|
| `GNUPGHOME` | `~/.gnupg` | The keyring + agent config |
| `PASSWORD_STORE_DIR` | `~/.password-store` | The `pass` store |
| `ZUUL_CONFIG_DIR` | `~/.config/zuul` | `config.json` |
| `ZUUL_NAMESPACE` | `bot` | Subdirectory inside the password store |

The bot passphrase file path is recorded inside `config.json` (`passphraseFile`); set it explicitly during setup (or edit `config.json`) if you want it somewhere other than `~/.bot-pass.txt`.

## Recommended layout

Put everything Zuul owns under a single directory and mount that as a volume. This is simpler than juggling four bind mounts and makes backups trivial.

```
/home/bot/
├── .bot-pass.txt
├── .config/zuul/config.json
├── .gnupg/
└── .password-store/
```

A single named volume mounted at `/home/bot/` covers all of it. If the container's user is `node` (the default in `node:*` images) use `/home/node/` instead and adjust the examples below.

## Installing the runtime dependencies

`node:22-bookworm-slim` does not ship with `gpg` or `pass`. Add them in your Dockerfile:

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      gnupg \
      pass \
    && rm -rf /var/lib/apt/lists/*

# Zuul itself
RUN npm install -g https://github.com/akalsey/Zuul.git

# Run as the unprivileged 'node' user that the base image already provides
USER node
WORKDIR /home/node

ENTRYPOINT ["/usr/local/bin/zuul-entrypoint.sh"]
CMD ["node", "your-bot.js"]
```

You do **not** need `pinentry`, `dbus`, `systemd`, or any desktop GPG packages. Zuul configures `gpg-agent` for loopback pinentry, which reads the passphrase straight from `~/.bot-pass.txt` — no UI prompt is ever produced.

## Doing setup

`zuul setup` is interactive (it refuses to run without a TTY) and it generates a 4096-bit RSA key, which needs entropy. You have two reasonable paths:

### Option A — set up on your workstation, ship the result

This is the pattern most people end up with. Run setup on your laptop, then transplant the data into a volume the container will mount.

```bash
# on your workstation (or any machine with a TTY)
zuul setup --bot-only

# copy the four artifacts into the volume the container will mount.
# example using a local docker volume:
docker volume create zuul-bot
docker run --rm -v zuul-bot:/dest -v "$HOME":/src:ro alpine sh -c '
  cp -a /src/.gnupg /dest/ &&
  cp -a /src/.password-store /dest/ &&
  cp -a /src/.config /dest/ &&
  cp /src/.bot-pass.txt /dest/ &&
  chown -R 1000:1000 /dest &&
  chmod 600 /dest/.bot-pass.txt &&
  chmod 700 /dest/.gnupg
'
```

(The `1000:1000` matches the `node` user in `node:22-bookworm-slim`. Adjust if your image uses a different UID.)

This approach also means the same bot key works on your workstation and in the container — handy for `zuul add` from your laptop. Anything you `zuul add` on the workstation lands in `~/.password-store/` and just needs to sync over (Syncthing, `rsync`, `git pull`, rebuild the volume, etc.) to be visible to the bot.

### Option B — set up inside a one-shot container

Run setup interactively against the volume, then use the volume from the long-running bot container:

```bash
docker volume create zuul-bot

docker run --rm -it \
  -v zuul-bot:/home/node \
  --user node \
  your-bot-image \
  zuul setup --bot-only
```

The `-it` flags give Zuul the TTY it requires. After setup completes the volume contains everything the bot needs and you can `docker compose up` the real service.

If key generation hangs ("not enough entropy"), make sure `/dev/urandom` is reachable inside the container (it is by default — only paranoid security policies block it) or install `rng-tools` in the image.

## Boot-time unlock — use an entrypoint

The systemd path inside `zuul setup` won't work in a container (no user session, no `systemctl --user`). The supported pattern is to call `zuul unlock` from your container entrypoint, before the bot process starts.

`/usr/local/bin/zuul-entrypoint.sh`:

```sh
#!/bin/sh
set -e

# Cache the bot passphrase in gpg-agent so the first `zuul get` is non-interactive.
# Safe to run on every container start; idempotent.
zuul unlock

exec "$@"
```

Reference it from the Dockerfile:

```dockerfile
COPY zuul-entrypoint.sh /usr/local/bin/zuul-entrypoint.sh
RUN chmod +x /usr/local/bin/zuul-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/zuul-entrypoint.sh"]
CMD ["node", "your-bot.js"]
```

Why this works: `zuul unlock` reads `~/.bot-pass.txt` and asks `gpg-agent` to cache the bot key. Setup writes a very long cache TTL (`default-cache-ttl 31536000`, one year), so the key stays unlocked for the lifetime of the container — which, for a long-running bot, is exactly the same lifetime guarantee `launchd`/`systemd` give on a real host.

If you'd rather skip the explicit unlock, you can: the first `zuul get` will lazily start `gpg-agent` and unlock the key the same way. The downside is one slow first call and a worse error if `~/.bot-pass.txt` is missing. The entrypoint pattern fails fast at container start, which is the better failure mode.

You should **not** answer "yes" to the boot-unlock prompt during `zuul setup` if you're inside a container — it will try to invoke `systemctl --user`, fail, and leave a dangling unit file in the volume. Answer "no", or use `--bot-only` and ignore the prompt.

## docker-compose example

```yaml
services:
  bot:
    build: .
    volumes:
      - zuul-bot:/home/node
    environment:
      # only set these if you moved the defaults during setup
      # GNUPGHOME: /home/node/.gnupg
      # PASSWORD_STORE_DIR: /home/node/.password-store
      # ZUUL_CONFIG_DIR: /home/node/.config/zuul
      ZUUL_NAMESPACE: bot
    restart: unless-stopped

volumes:
  zuul-bot:
```

If you need to add a credential from the host, exec into the container with a TTY:

```bash
docker compose exec bot zuul add metabase
```

`zuul add` requires a TTY and refuses to take the password on the command line, so this is the only way to add secrets from inside a running container. (Most people add from the workstation where setup happened and let the encrypted store sync into the volume.)

## Permissions and ownership

A few things will silently break if the volume's ownership is wrong:

- `~/.gnupg/` must be mode 700 and owned by the running user, or `gpg-agent` refuses to start.
- `~/.bot-pass.txt` must be mode 600. Zuul writes it that way; preserve the mode when you copy it into the volume.
- The container user (UID 1000 for `node:22-bookworm-slim`) must own everything under `/home/node/`. If you bind-mount from the host, match the UIDs or run a one-shot `chown` container first.

If you see `gpg: can't connect to the agent: IPC connect call failed` after restart, it's almost always a permissions problem on `~/.gnupg/` or its parent.

## Health check

A cheap healthcheck that proves the bot key is unlocked and the store is readable:

```dockerfile
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD zuul list >/dev/null 2>&1 || exit 1
```

`zuul list` only enumerates filenames, so it costs nothing and doesn't decrypt anything, but it does require config + password store to be present and accessible.

## Alpine note

If you're on `node:22-alpine` instead, install `gnupg pass bash` (busybox `sh` is fine for the entrypoint, but `pass` invokes `bash` internally). The Alpine `gnupg` package uses the same loopback-pinentry flow Zuul configures.

## Cross-machine bot key

If you already have a bot key on another machine and want the container to use it, follow [Importing an existing bot key](../README.md#importing-an-existing-bot-key) — copy `bot-key.asc` and `bot-pass.txt` into a temporary location inside the container (or onto the volume) and run `zuul import-key bot-key.asc --as-bot --passphrase-file bot-pass.txt` once. From then on the volume is fully provisioned and the entrypoint pattern above takes over.
