#!/usr/bin/env node

const MAX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;
const EXPECTED_TOOL_PATTERN = /^mcp__plugin_kimi_companion__[a-z0-9_]+$/;
// Claude Code defers MCP tool definitions by default, so the model must load
// the companion tool's schema through ToolSearch before it can call it. That
// call only reads schemas into context and executes nothing, and every actual
// invocation still has to match the single expected companion tool below.
const SCHEMA_LOOKUP_TOOL = "ToolSearch";

function decision(permissionDecision, permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason
    }
  };
}

function writeDecision(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const expectedTool = process.argv[2];
if (!EXPECTED_TOOL_PATTERN.test(expectedTool || "")) {
  writeDecision(decision("deny", "The Kimi command router was configured with an invalid companion tool."));
} else {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_HOOK_INPUT_BYTES) throw new Error("hook input exceeded its safety limit");
      chunks.push(buffer);
    }
    const input = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    const wellFormed = input !== null
      && typeof input === "object"
      && !Array.isArray(input)
      && input.hook_event_name === "PreToolUse";
    const allowed = wellFormed
      && (input.tool_name === expectedTool || input.tool_name === SCHEMA_LOOKUP_TOOL);
    writeDecision(allowed
      ? decision("allow", "This command may load its companion tool schema and call that single package-namespaced Kimi companion tool.")
      : decision("deny", "This Kimi command may call only its declared package-namespaced companion tool."));
  } catch {
    writeDecision(decision("deny", "The Kimi command router could not validate this tool call."));
  }
}
