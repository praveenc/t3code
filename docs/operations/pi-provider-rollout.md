# Pi provider rollout

> For maintainers. Using Pi Agent? See [the Pi user guide](../user/providers-pi.md).

Pi Agent is an opt-in Early Access provider with driver kind `piAgent`. It uses the shared ACP
runtime and a T3-patched `pi-acp` bridge. This runbook records the shipped constraints, validation
baseline, rollout checks, and rollback procedure.

## Release contract

Keep these values aligned in one change:

| Item          | Requirement                                                                |
| ------------- | -------------------------------------------------------------------------- |
| Pi            | 0.80.4 or newer, installed and authenticated separately on the environment |
| `pi-acp`      | Exactly 0.0.33                                                             |
| Bridge patch  | `patches/pi-acp@0.0.33.patch` in `pnpm-workspace.yaml` and the lockfile    |
| Provider kind | `piAgent`                                                                  |
| Default state | Disabled                                                                   |
| Settings      | `binaryPath`, `piBinaryPath`, `customModels`                               |
| UI status     | Early Access                                                               |

The `apps/server` dependency is exact, not a range. Packaging keeps `pi-acp` as a runtime-external
dependency so the CLI and desktop server can spawn its real entry file. The default `binaryPath` of
`pi-acp` resolves that bundled dependency and runs it with the current Node-compatible executable.
It does not resolve a global binary from `PATH`.

A non-default `binaryPath` runs that executable directly. Version probing alone is not enough to
make it safe. A custom bridge must also contain the T3 patch. The patch adds the one-shot Pi argument
file, T3 user-input forwarding, and the ACP permission option mapping used by the T3-owned Pi
extension.

Pi remains external. T3 must not install it, change its credentials, or copy its home into T3 state.
The provider's environment variables and both executable paths apply on the environment machine.

## Runtime layout

`PiDriver` owns one adapter and text-generation service per configured provider instance. The
adapter starts one ACP runtime per active T3 thread:

```text
T3 server
  Pi adapter for provider instance
    pi-acp child for thread A
      pi --mode rpc child for thread A
    pi-acp child for thread B
      pi --mode rpc child for thread B
```

The server resolves both executables before spawn. It passes the Pi executable through
`PI_ACP_PI_COMMAND`, writes a unique permission extension and JSON argument file below
`<stateDir>/providers/pi`, and sets `T3_PI_RUNTIME_MODE` for conversational sessions. Scoped cleanup
removes the temporary files and closes the child processes. Concurrent threads do not share their
argument or extension files.

Provider discovery and T3 text-generation calls also use short-lived ACP runtimes. They do not load
the permission extension. Discovery does not execute a user turn. Text generation sends a
T3-owned structured-output prompt and closes the scoped runtime after the request.

This is process separation, not privilege separation. Every child runs as the T3 server user with
the inherited environment and OS access.

## Model and permission mapping

Discovery starts an ACP session and reads authenticated model IDs, config options, slash commands,
and skills. T3 preserves full Pi model IDs such as `provider/model`. It maps Pi's `thought_level`
select option to T3's `thinkingLevel` selection and displays the available values supplied by Pi.
Thinking level does not affect T3 runtime mode or interaction mode.

Conversational sessions load the T3 permission extension. Its fixed policy is:

- Supervised: allow `read`, `grep`, `find`, and `ls`; ask for other tools.
- Auto-accept edits and Auto: also allow `edit` and `write`; ask for shell and unknown tools.
- Full access: allow every tool.

The extension intercepts Pi `tool_call` before execution and uses `ctx.ui.select` for decisions.
The patched bridge turns that request into ACP `session/request_permission`. Session approval is
kept in memory for the matching operation and disappears when the provider session closes. It never
writes a permanent Pi permission rule.

Do not describe this control as a sandbox. A custom Pi executable can bypass the policy if it does
not honor extension hooks, and the OS does not restrict an approved process.

## Session and log storage

Three stores participate in resume:

1. Pi writes native session files below `~/.pi/agent/sessions` by default. A configured
   `PI_CODING_AGENT_DIR` changes the Pi agent directory.
2. `pi-acp` maps ACP session IDs to Pi files in `~/.pi/pi-acp/session-map.json`.
3. T3 stores the opaque versioned ACP session ID as the thread's `resumeCursor` in the existing
   `provider_session_runtime` table in `<stateDir>/state.sqlite`.

On restart or continuation, T3 supplies the persisted ACP ID to `session/load`; `pi-acp` resolves the
native Pi file and starts a new Pi RPC process. T3 does not copy the Pi session into its database.
Deleting either Pi's native file or the bridge mapping breaks resume even when T3 still has a
cursor.

The Pi adapter writes native ACP request records through the shared provider event logger. Files are
thread-scoped as `<stateDir>/logs/provider/events.<thread-id>.log`; canonical provider events share
the same file with a different record label. Transient text and reasoning deltas are intentionally
filtered. Server stdout and `<stateDir>/logs/server.trace.ndjson` carry startup and structured span
diagnostics. See [Observability](./observability.md) for state-directory variants and retention.

Logs can contain prompts, tool inputs, paths, and output. Scrub them before attaching them to a
ticket.

## Known v1 limits

- The T3 plan-mode control is hidden for Pi. Pi input always uses T3's default interaction mode, and
  T3 passes `/plan` and `/default` through instead of treating them as T3 mode commands.
- T3 does not inject its per-thread MCP endpoint into Pi.
- The permission bridge is an application policy control, not an OS sandbox.
- Pi does not supply token or context-window usage to T3. Pi activity is absent from the Usage page,
  and the context meter has no Pi usage data.
- Checkpoint revert restores T3 and workspace state but does not rewind the native Pi conversation
  file. The current adapter only removes reverted turns from its in-memory view.

Keep cancellation coverage in the Early Access gate. Changes to Pi, the bridge patch, or the ACP
runtime must retain the running-tool process-tree test and the live marker smoke in the
[local test runbook](./pi-local-test.md).

## Validation baseline

The integrated candidate was validated in the exact internal checkout with:

- Node 24.18.0
- pnpm 11.10.0
- Pi 0.85.1
- patched `pi-acp` 0.0.33

`corepack pnpm install --frozen-lockfile` passed, including the repository supply-chain check. The
initial integration suite passed 658 tests:

| Area                                 | Tests |
| ------------------------------------ | ----: |
| Pi, server, and runtime ingestion    |   219 |
| Claude and Codex regression coverage |   252 |
| Contracts                            |    69 |
| `effect-acp`                         |     7 |
| Packaging                            |    77 |
| Web                                  |    20 |
| Mobile                               |    14 |

The server, web, mobile, contracts, `effect-acp`, and scripts type checks passed. Changed-file lint
passed across 69 files. Formatting, `git diff --check`, the web production build, and the
server/service-launcher bundle build also passed.

The running-tool cancellation fix then passed 126 focused Pi and ACP tests across nine files. The
`t3` and `effect-acp` type checks, changed-file lint and formatting, `git diff --check`, and the
server and service-launcher bundle build passed. Only pre-existing Effect suggestions appeared in
the server type check.

The live smoke passed with the [local Pi provider test runbook](./pi-local-test.md): provider
readiness and authentication, model and Thinking selection, streamed reasoning and text, an
approved tool, a denied permission with no side effect, running-tool and descendant-process
cancellation with no late mutation or output, same-session resume, and final `RESUME_OK` output.
The isolated server was stopped and its port was released.

A repository-wide check was not run because repository policy reserves it for CI unless a
maintainer requests it. Browser automation and native mobile automation were not run because they
require explicit approval. These are rollout gaps, not hidden passes.

## Internal rollout checklist

### Before packaging

- [ ] Confirm `apps/server/package.json` pins `pi-acp` to exactly 0.0.33.
- [ ] Confirm the lockfile patch hash matches `patches/pi-acp@0.0.33.patch`.
- [ ] Confirm CLI, desktop, and Windows/WSL packaging retain the bridge and patch.
- [ ] Install with `corepack pnpm install --frozen-lockfile` in a clean checkout.
- [ ] Run the focused Pi, ACP, contracts, web, mobile, packaging, and existing-provider tests.
- [ ] Run affected type checks, changed-file lint, formatting, and web/server builds.
- [ ] Review user-facing labels against `PiSettings`: **pi-acp binary path**, **Pi binary path**,
      **Thinking**, **Early Access**, and disabled-by-default behavior.

### Canary

- [ ] Use an isolated T3 home. Never point a canary at a maintainer's live `~/.t3/userdata`.
- [ ] Record T3, Node, Pi, and bridge versions.
- [ ] Authenticate Pi with a non-production test account and confirm at least one model appears.
- [ ] Test web or desktop locally, then one remote client against the same environment.
- [ ] Start a Pi thread, stream reasoning and text, run a read tool, approve one edit or shell tool,
      and reject one effectful tool.
- [ ] Interrupt a running shell turn, confirm the process tree stops with no late workspace side
      effect or output, and resume the same thread.
- [ ] Restart the T3 server and resume again to exercise all three session stores.
- [ ] Select Pi under **Text generation model** and generate a title. Select it under **Source
      control writer model** and generate source-control text.
- [ ] Verify existing Codex and Claude threads still start, interrupt, and resume.
- [ ] Inspect stdout, the server trace, and the thread's provider event log for credentials or
      unexpected protocol errors before sharing evidence.

### Expansion

- [ ] Keep Pi opt-in and the Early Access badge during the first release.
- [ ] Give canary users the user guide and local test runbook before enablement.
- [ ] Track provider discovery failures, resume failures, malformed ACP output, permission bypasses,
      and cancellation timeouts.
- [ ] Expand only after the canary completes model, tool, denial, running-tool cancellation,
      restart, and resume checks on the packaged build.
- [ ] Do not remove the Early Access label until the missing v1 integrations have explicit product
      decisions.

## Rollback

Pi is opt-in, so disable it before rolling back the whole build:

1. Ask users to stop active Pi turns and wait for any cancellation to settle.
2. Change **Text generation model** and **Source control writer model** away from Pi.
3. Turn off every Pi Agent provider instance. Disabling or replacing the instance closes its adapter
   scope and child processes.
4. Verify Codex, Claude, and any other enabled provider still start a thread.
5. If the release itself must roll back, snapshot the T3 database with the normal release procedure,
   deploy the previous T3 version, and keep Pi disabled.

Do not delete `~/.pi/agent/sessions`, `~/.pi/pi-acp/session-map.json`, or T3's
`provider_session_runtime` rows during rollback. They are not daemon state and do not need cleanup.
Keeping them makes a later fixed build able to resume existing Pi threads.

The bridge has no background service to uninstall. Roll back the T3 package and its patch together.
Never pair an older or newer upstream `pi-acp` package with the T3 permission extension based only
on a matching executable name.

Rollback is complete when no Pi instance is enabled, no Pi model is selected for generated text,
existing providers pass a short smoke test, and a fresh server start reports no Pi spawn attempt.
