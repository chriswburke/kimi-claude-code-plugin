---
description: Ask Kimi Code for a read-only implementation plan
argument-hint: "[--background] [--model <model> | --profile <profile>] [--label <label>] [--timeout <duration>] <objective>"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* Task* Todo* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__plan"]
---

The invocation text is appended below by Claude Code under `ARGUMENTS:`.
Call `mcp__plugin_kimi_companion__plan` exactly once. Pass the complete appended
argument value through `rawArguments` without executing, interpolating, or
rewriting it. Do not use Bash, inspect the repository yourself, or implement
the plan. Return the tool result verbatim.
