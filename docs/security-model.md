---
meta:
  title: Understand the Kimi Code Companion security model
  navLabel: Security Model
  category: Security
  contentType: Conceptual
---

# Understand the Kimi Code Companion security model

Kimi commands use narrow tool routing and recoverable process guards. They protect companion metadata but do not sandbox Claude Code, Kimi Code, the operating system, trusted repositories, or Kimi startup configuration.

## Command boundaries

Each slash command removes Claude Code built-in tools for its invocation and routes one package-namespaced Model Context Protocol (MCP) operation through a fail-closed scoped gate. Command text reaches MCP as JSON, not shell syntax, and the runtime launches the Kimi binary with an argument array. Each command has a distinct boundary:

- `/kimi:ask` is autonomous and can modify a trusted checkout.
- `/kimi:explore` and `/kimi:plan` use a request-local agent that grants only `Read`, `Grep`, and `Glob`.
- `/kimi:review` receives precomputed Git context with empty tool and skill allowlists.
- Experimental `/kimi:session` passes an empty Claude-side MCP server list to the Agent Client Protocol (ACP).

The gate does not replace local or managed Claude Code policy. A disabled hook falls back to that policy’s normal companion-tool decision.

## Kimi startup and containment

Kimi’s documented CLI cannot disable its user-level hooks or MCP startup configuration. That configuration can launch code outside the request-local boundary. Use a dedicated Kimi home without extensions, or an operating-system/container sandbox, when you need a narrower trust base.

Managed guards handle cancellation, deadlines, owner-loss recovery, and process-group cleanup. They are not an operating-system sandbox. On POSIX they cover descendants that remain in the launched process group, but a process escapes that group by daemonizing or creating a new session. Use a container, virtual machine, cgroup, job boundary, or another operating-system sandbox for hard containment.

## Private state and executable trust

The companion stores state in a private canonical directory, rejects symbolic links and unsafe components, bounds reads, and writes atomically. Generic locks have token-owned identities and fail closed on malformed or unexpected state. Usage records exclude prompt, output, diagnostic, path, credential, PID, and worker-token data. Kimi native sessions remain in Kimi Code’s separate store.

On POSIX, implicit Kimi and Git lookup requires nonempty absolute `PATH` entries, rejects candidates inside the repository, and checks ownership and group/world write permissions. `KIMI_BIN` is an explicit absolute-path decision and receives the same checks. The Windows paths accept native `.exe` and `.com` providers, not `.cmd` or `.bat` wrappers, but no automated suite exercises them. The manifest and hook still launch bare `node`, so the outer Node executable and inherited `PATH` remain trusted prerequisites.

For the complete package-level contract, read the [Kimi package security model](../plugins/kimi/README.md#security-model).
