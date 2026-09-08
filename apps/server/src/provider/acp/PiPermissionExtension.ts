export const T3_PI_PERMISSION_EXTENSION_SOURCE = String.raw`// T3-owned Pi extension. pi-acp forwards approval and input requests to T3.

const ALLOW_ONCE = "Allow once";
const ALLOW_FOR_SESSION = "Allow for this session";
const REJECT = "Reject";
const READ_SEARCH_TOOLS = new Set(["read", "grep", "find", "ls"]);
// Pi Auto is deliberately deterministic. Unknown and shell tools always ask.
const AUTO_TOOLS = new Set([...READ_SEARCH_TOOLS, "edit", "write"]);

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]));
  }
  return value;
}

function operationKey(event) {
  return JSON.stringify({ toolName: event.toolName, input: normalized(event.input ?? {}) });
}

function toolDetail(event) {
  const input = event.input ?? {};
  if (event.toolName === "bash" || event.toolName === "powershell") {
    return typeof input.command === "string" ? input.command : event.toolName;
  }
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof input[key] === "string") return event.toolName + ": " + input[key];
  }
  return event.toolName;
}

function modeAllows(toolName) {
  const mode = process.env.T3_PI_RUNTIME_MODE ?? "approval-required";
  if (mode === "full-access") return true;
  if (mode === "auto" || mode === "auto-accept-edits") return AUTO_TOOLS.has(toolName);
  return READ_SEARCH_TOOLS.has(toolName);
}

export default function t3PermissionExtension(pi) {
  const sessionApprovals = new Set();
  pi.on("tool_call", async (event, ctx) => {
    const key = operationKey(event);
    if (modeAllows(event.toolName) || sessionApprovals.has(key)) return;
    if (!ctx.hasUI) {
      return { block: true, reason: "T3 approval is unavailable for this Pi tool call." };
    }

    const decision = await ctx.ui.select(
      "Allow Pi to run " + event.toolName + "?\n" + toolDetail(event),
      [ALLOW_ONCE, ALLOW_FOR_SESSION, REJECT],
      { signal: ctx.signal },
    );
    if (decision === ALLOW_FOR_SESSION) sessionApprovals.add(key);
    if (decision === ALLOW_ONCE || decision === ALLOW_FOR_SESSION) return;
    return { block: true, reason: "Blocked by T3 runtime permissions." };
  });
}
`;
