---
description: Use experimental Kimi ACP sessions
argument-hint: "--experimental <list [--json] | start [--model <model> | --profile <profile>] [--json] <prompt> | continue <session-id> [--json] <prompt> | fork <session-id> [--json]>"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* Task* Todo* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__session"]
---

The experimental session action is appended below under `ARGUMENTS:`. Call
`mcp__plugin_kimi_companion__session` exactly once and pass that complete value
through `rawArguments` without executing, interpolating, or rewriting it.
Return the tool result verbatim. Do not emulate unsupported session operations,
inspect Kimi's session files, or perform the request yourself.
