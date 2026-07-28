---
description: Show the result of a Kimi companion job
argument-hint: "[job-id] [--wait] [--timeout <duration>] [--json]"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* Task* Todo* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__result"]
---

The optional job ID and wait options are appended below under `ARGUMENTS:`. Call
`mcp__plugin_kimi_companion__result` exactly once and pass that complete value
through `rawArguments` without executing, interpolating, or rewriting it.
Return the tool result verbatim. Do not poll or wait outside the tool call.
