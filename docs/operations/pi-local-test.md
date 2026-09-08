# Local Pi provider test

> For contributors validating Pi Agent against a local T3 checkout. For installation, settings,
> sessions, and current limits, read [the Pi user guide](../user/providers-pi.md). This runbook uses
> the web client because one `dev` command starts contracts, server, and web together.

## Supported baseline and prerequisites

The validated local baseline is Linux with Node 24.18.0, pnpm 11.10.0, Pi 0.85.1, and T3's patched
`pi-acp` 0.0.33. The repository requires Node `^24.13.1`, pins pnpm 11.10.0, and accepts Pi 0.80.4
or newer.

Run these checks from the repository root:

```bash
node --version
corepack pnpm --version
command -v pi
pi --version
node -p 'require("./apps/server/package.json").dependencies["pi-acp"]'
sha256sum patches/pi-acp@0.0.33.patch
```

The final two commands must print `0.0.33` and this reviewed patch hash:

```text
a81e30cb0d19f7490172895b4d915363e04ef1b2f65288eb9e8b7cd0db55f28d
```

Do not put provider credentials on a command line. Run `pi`, use `/login` in Pi's interactive
session, select a provider, and verify one model can answer. Then exit Pi. This stores credentials in
Pi's normal configuration rather than shell history. If you use `PI_CODING_AGENT_DIR`, export only
that directory path before starting Pi and T3. Do not export a credential value.

## Install the pinned checkout

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter t3 list pi-acp --depth 0
```

The install runs the repository's supply-chain check. The second command must show
`pi-acp@0.0.33`. The lockfile applies `patches/pi-acp@0.0.33.patch`; do not replace it with an
unpatched global bridge.

## Deterministic tests

These tests use mocks and a controlled process tree. They do not call an authenticated model:

```bash
corepack pnpm --filter t3 exec vp test run \
  src/provider/Layers/PiAdapter.test.ts \
  src/provider/Layers/PiProvider.test.ts \
  src/provider/acp/PiAcpSupport.test.ts \
  src/provider/acp/PiPermissionExtension.test.ts \
  src/provider/acp/AcpCoreRuntimeEvents.test.ts \
  src/provider/acp/AcpRuntimeModel.test.ts
corepack pnpm --filter effect-acp exec vp test run
corepack pnpm --filter t3 typecheck
corepack pnpm --filter effect-acp typecheck
```

`PiAdapter.test.ts` includes the cancellation regression. It starts a controlled parent and nested
child, interrupts the turn, immediately resumes the same session, waits beyond the original command
duration, and checks that neither the marker nor late output survives.

## Start the local app

Use an isolated T3 home. Never point a test run at `~/.t3/userdata`.

```bash
export T3_PI_TEST_HOME="$PWD/.t3/pi-local-test"
corepack pnpm dev --home-dir "$T3_PI_TEST_HOME"
```

Keep this terminal open. Its first line starts with `[dev-runner]` and reports `serverPort`,
`webPort`, and `baseDir`. The ports can move when another process owns the preferred pair, so copy
the reported values rather than assuming 13773 and 5733. Open the printed `Pairing URL`, including
its one-time token. Do not paste that URL into logs, issues, or chat.

Expected startup evidence:

- The `[dev-runner]` line names the isolated base directory.
- Contracts, server, and web enter watch mode without an exit.
- The server prints `Authentication required` and a pairing URL for
  `http://localhost:<webPort>/pair`.
- After pairing, the app loads through `http://localhost:<webPort>`.

Do not set `VITE_HTTP_URL` or `VITE_WS_URL`. Local web development is single-origin, and Vite
proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the reported server port.

## Configure Pi Agent

1. Open **Settings > Providers > Pi Agent** and enable the provider.
2. Keep **pi-acp binary path** set to `pi-acp`. That value selects the pinned patched dependency
   from this checkout, not a global executable.
3. Keep **Pi binary path** set to `pi`, or use the absolute path printed by `command -v pi` when the
   dev server cannot see your interactive shell's `PATH`.
4. Select **Refresh provider status**. Expect `Authenticated`, Pi's version, and at least one model.
   The terminal must not report ACP discovery or compatibility errors.
5. Start a new thread. Pick a Pi model in provider-qualified `provider/model` form, for example
   `anthropic/claude-sonnet-4-6`, then choose the strongest advertised non-Off **Thinking** level.
6. Set the composer runtime mode to **Supervised**. Thinking controls model reasoning effort.
   Runtime mode controls tool approval. Pi does not expose T3 plan mode.

A custom **pi-acp binary path** is for development or recovery only. It must be an executable
patched `pi-acp` 0.0.33. An upstream 0.0.33 binary has the same version but lacks T3's permission and
cancellation changes.

## Live provider smoke test

This section calls the authenticated model and can consume provider quota. Run it only after the
provider card reports `Authenticated`.

Use a disposable project directory inside the checkout:

```bash
mkdir -p .t3/pi-smoke-project
rm -f .t3/pi-smoke-project/{approved.txt,denied.txt,cancelled.txt,nested.pid}
```

Add `.t3/pi-smoke-project` as a T3 project and open the Pi thread configured above. Send each prompt
separately. Let a turn finish before starting the next unless the step says to stop it.

### 1. Stream reasoning, text, and an approved tool

```text
Briefly reason about the request, then use bash to run:
printf 'approved\n' > approved.txt
After the tool finishes, reply with exactly APPROVED_OK.
```

Approve the shell request once. Expect a live **Thinking** row followed by incremental assistant
text, an inline tool row that settles successfully, `APPROVED_OK`, and `approved.txt` containing
`approved`.

### 2. Deny an effectful tool with no side effect

```text
Use bash to run:
printf 'denied\n' > denied.txt
Do not use another tool or another way to create the file. If permission is denied, reply with
exactly DENIED_OK.
```

Reject the shell request. Expect the approval card and a declined or failed tool row, then
`DENIED_OK`. Confirm `denied.txt` is absent:

```bash
test ! -e .t3/pi-smoke-project/denied.txt
```

### 3. Cancel a running tool and its descendant

```text
Use bash to run this exact command and do not change it:
sh -c 'sleep 20; printf "descendant\n" > cancelled.txt' & echo $! > nested.pid; wait
After it finishes, reply with exactly CANCEL_SHOULD_NOT_FINISH.
```

Approve the request. Wait until the tool row is running and `nested.pid` exists, then click the
composer's **Stop generation** button. Expect the turn to end with `You stopped this response` and
the tool row to settle as failed or cancelled exactly once. There must be no
`CANCEL_SHOULD_NOT_FINISH` output.

Wait beyond the original command duration, then check both the side effect and descendant PID:

```bash
sleep 22
test ! -e .t3/pi-smoke-project/cancelled.txt
PID="$(cat .t3/pi-smoke-project/nested.pid)"
! kill -0 "$PID" 2>/dev/null
```

Both checks must pass. The marker must remain absent and the nested process must be gone.

### 4. Resume the same Pi session

In the same T3 thread, send:

```text
Reply with exactly RESUME_OK. Do not use tools.
```

Expect `RESUME_OK` in a new completed turn. No cancelled-tool output, marker content, or delayed
assistant message may appear before or after it. The thread keeps the same Pi session; do not create
a new thread for this step.

For log evidence, keep the dev terminal output and inspect:

```bash
tail -n 100 "$T3_PI_TEST_HOME/userdata/logs/server.trace.ndjson"
find "$T3_PI_TEST_HOME/userdata/logs/provider" -name 'events.*.log' -type f -print
```

The trace should have no Pi compatibility, auth, or cancellation-timeout error. The thread provider
log should show one cancelled terminal outcome before the resumed turn. Provider logs can contain
prompts, tool inputs, paths, and model output. Do not share them without review.

## Stop and clean up

Press `Ctrl+C` once in the terminal that runs `corepack pnpm dev`, then wait for it to return to the
shell. Use the exact ports from the `[dev-runner]` line:

```bash
SERVER_PORT=<reported-serverPort>
WEB_PORT=<reported-webPort>
! ss -H -ltn "( sport = :$SERVER_PORT or sport = :$WEB_PORT )" | grep -q .
```

That check must return success with no output. Check for children that still carry this test run's
isolated T3 home. The server, `pi-acp`, and Pi RPC process inherit this value, while other T3
worktrees and this coding agent do not:

```bash
FOUND=0
for proc in /proc/[0-9]*; do
  grep -zFqx "T3CODE_HOME=$T3_PI_TEST_HOME" "$proc/environ" 2>/dev/null || continue
  pid="${proc##*/}"
  comm="$(cat "$proc/comm" 2>/dev/null || true)"
  cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
  cmd="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
  printf '%s\t%s\t%s\t%s\n' "$pid" "$comm" "$cwd" "$cmd"
  FOUND=1
done
test "$FOUND" -eq 0
```

No rows should print. If a row remains, inspect its PID, parent, command line, and working directory
before stopping it. Never kill by a name, path pattern, or broad `pkill` expression. Remove the
isolated state and smoke project only after the process and listener checks pass:

```bash
rm -rf "$T3_PI_TEST_HOME" .t3/pi-smoke-project
unset T3_PI_TEST_HOME
```

## Troubleshooting

### A binary is missing

Run `command -v pi` and `pi --version` in the same shell that starts T3. Set **Pi binary path** to
the absolute executable when needed. For a missing bridge, reset **pi-acp binary path** to `pi-acp`
and rerun the frozen install. Do not fix it by installing an unpatched global bridge.

### Authentication fails or no models appear

Exit T3, run `pi`, complete `/login`, and verify a model answers in Pi. Restart T3 and select
**Refresh provider status**. If Pi uses a custom `PI_CODING_AGENT_DIR`, start both Pi and T3 with the
same directory setting. Never print credential files or values while diagnosing this.

### T3 reports an incompatible bridge

Confirm `apps/server/package.json` contains exact `0.0.33`, the patch hash matches the value above,
and `corepack pnpm --filter t3 list pi-acp --depth 0` resolves 0.0.33. Leave the bridge setting at
`pi-acp`. A custom path must contain T3's reviewed patch, not only the matching upstream version.

### The preferred ports are occupied

The dev runner scans for a free pair and prints the selected ports. Use its `[dev-runner]` values
and pairing URL. If startup still reports a bind error, inspect the exact reported port with
`ss -H -ltnp "sport = :<port>"`. Do not stop an unrelated listener.

### Provider health stays unavailable

Check the provider card's full message, then inspect the dev terminal and
`$T3_PI_TEST_HOME/userdata/logs/server.trace.ndjson`. Common causes are a Pi version below 0.80.4,
a Pi path hidden from the server process, different Pi homes between login and T3, no authenticated
models, or an unpatched custom bridge. After correcting the cause, select **Refresh provider
status**.

### A child process remains after shutdown

First confirm the PID's `/proc/<pid>/cwd`, `/proc/<pid>/cmdline`, and parent PID belong to this test
run. If it owns one of the reported ports, confirm the same details through `ss -H -ltnp`. Stop only
that confirmed PID. Do not use `pkill -f`, `pgrep | kill`, or a worktree-path match because other T3
sessions and this coding agent can share those strings.
