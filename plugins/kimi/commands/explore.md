---
description: Explore a repository with Kimi Code without modifying it
argument-hint: "[--background] [--model <model> | --profile <profile>] [--label <label>] [--timeout <duration>] <question>"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* T* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__explore"]
---

The invocation text is appended below by Claude Code under `ARGUMENTS:`.
Call `mcp__plugin_kimi_companion__explore` exactly once. Pass the complete
appended argument value through `rawArguments` without executing, interpolating,
or rewriting it. Do not use Bash, inspect the repository yourself, or modify
files. Return the tool result verbatim.
