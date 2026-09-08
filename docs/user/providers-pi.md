# Pi Agent

Pi Agent support is in Early Access. T3 Code runs Pi on the connected environment through a
pinned ACP bridge. If you connect from the hosted web app or mobile, install and authenticate Pi on
the server machine, not on the device in your hand. Contributors can use the
[local Pi provider test runbook](../operations/pi-local-test.md) to validate a checkout.

## Install and authenticate Pi

T3 Code requires Pi 0.80.4 or newer. Install Pi on the server machine:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

Start Pi in a terminal on that machine:

```bash
pi
```

Use `/login` inside Pi to configure a model provider. Confirm that Pi can list and run one of that
provider's models before opening T3 Code.

T3 Code includes its supported `pi-acp` bridge as an exact `0.0.33` dependency with a reviewed T3
patch. A normal installation does not need a global `pi-acp` install. Keep **pi-acp binary path** set
to `pi-acp` to use the bundled bridge. This value selects T3 Code's bundled package, even if another
`pi-acp` is on `PATH`.

A custom bridge path is for development and recovery only. It must point to `pi-acp` 0.0.33 with
the T3 patch that loads the permission extension. The unpatched package from npm has the right
version number but cannot enforce T3's Pi permission modes.

## Enable Pi Agent

1. Open **Settings** and select **Providers**.
2. Select **Pi Agent**, which has an **Early Access** badge.
3. Leave **pi-acp binary path** as `pi-acp` unless you have a reviewed custom bridge.
4. Leave **Pi binary path** as `pi`, or enter the absolute path from `command -v pi`.
5. Turn on the provider.
6. Select **Refresh provider status** after changing Pi authentication or configuration.

The provider is ready when Settings reports it as installed and authenticated and shows at least
one model. On mobile, use **Refresh models** after changing the server-side setup.

Packaged desktop apps and background services can have a smaller `PATH` than an interactive shell.
Use an absolute Pi path when `pi --version` works in your terminal but T3 Code reports that Pi is
missing. Both binary paths refer to the machine running the T3 server.

Provider instances inherit the server environment. You can add instance-specific environment
variables in the provider card. Mark API keys as sensitive. If you authenticated Pi with a custom
`PI_CODING_AGENT_DIR`, add the same variable to that Pi provider instance so discovery and chat use
the same credentials and sessions.

## Models and thinking levels

Pi supplies the model list after authentication. Model identifiers keep Pi's full
`provider/model` form, such as `anthropic/claude-sonnet-4-6`. T3 Code may show the provider and
model name separately, but it saves and sends the full identifier.

Open the provider's **Models** tab if you need to add a model that Pi accepts but does not advertise.
A custom entry must use the exact identifier Pi expects.

The **Thinking** control comes from Pi's ACP model configuration. It can offer Off, Minimal, Low,
Medium, High, Extra High, or Max. T3 Code sends the selected value to Pi's `thought_level` option
when it starts or resumes the session. Pi supplies the available values and default during provider
discovery, so they can change with Pi's model configuration.

Thinking level is model reasoning effort. It does not change T3's permission mode, and it is not
T3's plan mode.

## Permission modes

T3 Code loads its permission extension into conversational Pi sessions. The extension checks Pi
tool calls before the tool runs.

| T3 mode               | Pi behavior                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Supervised**        | Read and search tools run. Edits, writes, shell commands, and unknown tools ask first.                                     |
| **Auto-accept edits** | Read, search, edit, and write tools run. Shell commands and unknown tools ask first.                                       |
| **Auto**              | Uses the same deterministic Pi allowlist as Auto-accept edits in this version. Shell commands and unknown tools ask first. |
| **Full access**       | All Pi tools run without a T3 approval prompt.                                                                             |

**Always allow this session** remembers the matching Pi operation for the current provider session.
It does not create a permanent Pi rule and does not change the thread to Full access.

These checks are application policy, not an operating-system sandbox. Pi tools run as the T3 server
user and can access anything that user can access. Use a worktree, container, virtual machine, or
another OS isolation boundary when the repository or command is not trusted.

## Sessions and resume

Pi keeps native conversation files under `~/.pi/agent/sessions` by default. A custom
`PI_CODING_AGENT_DIR` changes Pi's agent directory. `pi-acp` stores the ACP-to-Pi mapping in
`~/.pi/pi-acp/session-map.json`, and T3 Code stores the opaque ACP resume ID in its own environment
database.

Each active T3 Pi thread gets its own `pi-acp` process and Pi RPC child process. Stopping a session
closes those children, but it does not delete the native Pi session file. Continuing the T3 thread
starts a new process pair and loads the saved Pi session.

The session files and credentials stay on the environment. Web, desktop, and mobile clients receive
T3's projected conversation, not the Pi files or credentials.

T3 checkpoint restore returns workspace files and T3's visible thread to the selected checkpoint.
The v1 T3 Pi adapter does not rewind the native Pi conversation, so the saved Pi conversation can
still contain turns after that checkpoint. Start a new thread when the upstream Pi context must
exclude reverted turns.

## Use Pi for generated text

After Pi Agent is ready, Pi models can drive T3's generated text:

- Choose a Pi model under **Settings > General > Text generation model** for thread titles and the
  default generated source-control text.
- Choose a Pi model under **Settings > Source control > Source control writer model** to override
  the global choice for branch names, commit messages, and change request titles and descriptions.

T3 uses a short-lived Pi ACP session for each generation request and applies the selected Thinking
value.

## Current limits

- T3 plan mode is unavailable for Pi. T3 does not consume `/plan` or `/default` as interaction-mode
  commands for Pi, so those strings go to Pi as ordinary slash commands. No native Pi plan-mode
  integration ships in this version.
- T3 does not inject its per-thread MCP server into Pi. MCP tools configured independently in the Pi
  environment are separate from T3's thread MCP endpoint.
- T3's Pi permission extension is not an OS sandbox.
- Pi does not report token counts or context-window usage through this integration. Pi activity is
  not included in T3's Usage page, and the context meter has no Pi usage data.
- Restoring a T3 checkpoint does not rewind the native Pi conversation file.

## Troubleshooting

### Pi is not installed

Run these commands on the server machine:

```bash
command -v pi
pi --version
```

Install Pi or set **Pi binary path** to the executable. T3 Code rejects Pi versions older than
0.80.4.

### The bridge is missing or has the wrong version

Reset **pi-acp binary path** to `pi-acp` and reinstall the same T3 Code server version if the bundled
bridge is missing. T3 Code requires its patched `pi-acp` 0.0.33. Do not point the setting at an
unpatched global installation.

### No authenticated models appear

Run `pi`, use `/login`, and verify a model works in Pi. Then select **Refresh provider status** in
T3 Code. If you use `PI_CODING_AGENT_DIR` or provider API-key variables, put the same values on the
T3 provider instance.

### Discovery times out or fails

Run Pi once in an interactive terminal to finish first-run setup. Check that both configured binary
paths are executable by the T3 server user. Then inspect server output and the logs described below
before refreshing provider status.

### A saved model is rejected

Refresh provider status. Select one of the current authenticated models and its advertised Thinking
value. Pi can remove a model when credentials or provider configuration change.

### Resume fails

Confirm that Pi's session directory and `~/.pi/pi-acp/session-map.json` belong to the same server
user and Pi home used when the thread started. Do not delete the mapping file or native Pi session
while T3 threads still depend on it.

### Find diagnostic logs

Normal server logs go to the server process's stdout. Structured traces live at
`<T3 state>/logs/server.trace.ndjson`. Provider protocol and canonical events are split by thread
under `<T3 state>/logs/provider/events.<thread-id>.log`. Production state normally means
`~/.t3/userdata`; a worktree dev run uses `<worktree>/.t3/userdata`.

SSH-managed environments also keep the remote server output in their SSH launch log. Provider logs
can contain prompts, tool inputs, paths, and model output. Treat them as sensitive when sharing a
bug report.
