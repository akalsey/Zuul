# OpenClaw Plugin for Gatepass

## Overview

A separate npm package, `@akalsey/openclaw-gatepass`, that bundles the gatepass secrets-management skill and installs the gatepass CLI as a dependency. OpenClaw users install one package and get everything: the CLI tool and the agent skill.

## Packages

**`@akalsey/gatepass`** (existing) — the CLI tool. One change: add `"skills"` to the `files` array in `package.json` so skill files are included in the published npm artifact.

**`@akalsey/openclaw-gatepass`** (new) — the OpenClaw plugin. Lives in a separate repository. Depends on `@akalsey/gatepass`.

## Plugin Structure

```
openclaw-gatepass/
  package.json          ← openclaw metadata + @akalsey/gatepass dependency
  openclaw.plugin.json  ← manifest OpenClaw validates on install
  scripts/
    postinstall.js      ← copies skills from installed gatepass into skills/
  skills/               ← gitignored, assembled at install time by postinstall.js
  README.md
```

## Skills Assembly

Skills are maintained only in `@akalsey/gatepass`. The plugin never duplicates them.

`postinstall.js` runs after every `npm install` or `npm update`:
1. Locates the installed gatepass package using `require.resolve('@akalsey/gatepass/package.json')` — works regardless of npm hoisting
2. Copies the `skills/` directory from gatepass into the plugin's own `skills/` directory

`skills/` is gitignored in the plugin repo. It is assembled at install time only.

## Manifest

`openclaw.plugin.json`:
```json
{
  "name": "@akalsey/openclaw-gatepass",
  "description": "Secrets management for OpenClaw agents via gatepass",
  "skills": ["skills/secrets-management"],
  "pluginApi": "1.0"
}
```

`package.json` openclaw metadata:
```json
"openclaw": {
  "compat": { "pluginApi": "1.0" }
}
```

## Install Flow

```
clawhub install @akalsey/openclaw-gatepass
```

1. npm installs `@akalsey/openclaw-gatepass`
2. npm installs `@akalsey/gatepass` as a dependency (provides the `gatepass` CLI binary)
3. `postinstall.js` copies skill files into `skills/`
4. OpenClaw loads `skills/secrets-management/SKILL.md`

## Skill Update Flow

When gatepass ships a skill update:
1. Bump gatepass version in `openclaw-gatepass/package.json` dependency range
2. User runs `npm update @akalsey/openclaw-gatepass`
3. npm updates gatepass, reruns postinstall, fresh skills copied

No separate plugin release is required for skill-only changes beyond the version bump.

## Changes to `@akalsey/gatepass`

Add `"skills"` to `files` in `package.json`:

```json
"files": [
  "bin",
  "src",
  "skills",
  "README.md"
]
```
