# Testing the Pi Agent build

This branch adds **Pi Agent** (Early Access) to T3 Code. It is an ordinary T3
Code checkout — everything else behaves as usual. This file is the quickstart
for trying Pi; the full reference is
[docs/user/providers-pi.md](docs/user/providers-pi.md).

## Prerequisites

- **Node 24** (the repo pins `^24.13.1`). `node --version` should print `v24.x`.
- **pnpm** via corepack: `corepack enable` (pnpm 11 and 12 both work).
- To run real Pi turns (not just see the provider), **Pi CLI >= 0.80.4**
  installed and authenticated on this machine:
  ```bash
  npm install -g @earendil-works/pi-coding-agent
  pi --version      # expect >= 0.80.4
  pi                 # then /login and confirm a model works
  ```
  You can launch and browse the app without Pi installed — you just cannot start
  a Pi turn until it is present and authenticated.

## Clone & install

```bash
git clone -b pi-test-1 https://github.com/praveenc/t3code.git
cd t3code
pnpm install
```

## Run

If you **already use T3 Code**, point this checkout at its own datastore so its
migrations do not touch your real `~/.t3` (this also avoids a pairing failure on
a mismatched database):

```bash
export T3CODE_HOME="$PWD/.t3"   # fresh, isolated, gitignored
```

Then start it:

```bash
pnpm dev
```

Open the **webPort** from the `[dev-runner] ... webPort=<W> ...` line
(`http://localhost:<W>`). Do not set any `VITE_*` env — dev is single-origin and
Vite proxies the backend.

## Pair (the first screen asks for a token)

In a **second terminal**, with the **same `T3CODE_HOME`** exported:

```bash
export T3CODE_HOME="$PWD/.t3"
node apps/server/src/bin.ts pair
```

Open the printed **Pairing URL**, or paste the **Token** into the form. Tokens
last 5 minutes; re-run to mint another.

## Enable Pi

**Settings → Providers → Pi Agent** (Early Access badge) → leave both binary
paths at their defaults (`pi-acp`, `pi`) → turn it on → **Refresh provider
status**. If T3 reports Pi is missing even though `pi --version` works in your
terminal, set **Pi binary path** to the output of `command -v pi` (packaged apps
can see a thinner `PATH` than your shell). Full setup, permission modes, limits,
and troubleshooting: [docs/user/providers-pi.md](docs/user/providers-pi.md).

## Reporting issues

Say what you did, what you expected, and what happened, and include the relevant
server output. Logs live under `<T3CODE_HOME>/userdata/logs/`. Provider logs can
contain prompts, tool inputs, and model output — scrub them before sharing.
