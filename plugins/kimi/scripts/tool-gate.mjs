#!/usr/bin/env node

const MAX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;
const EXPECTED_TOOL_PATTERN = /^mcp__plugin_kimi_companion__[a-z0-9_]+$/;

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
    const allowed = input !== null
      && typeof input === "object"
      && !Array.isArray(input)
      && input.hook_event_name === "PreToolUse"
      && input.tool_name === expectedTool;
    writeDecision(allowed
      ? decision("allow", "This command may call its single package-namespaced Kimi companion tool.")
      : decision("deny", "This Kimi command may call only its declared package-namespaced companion tool."));
  } catch {
    writeDecision(decision("deny", "The Kimi command router could not validate this tool call."));
  }
}
