# Kimi companion for Claude Code

An independent Claude Code plugin for Kimi Code delegation, tool-constrained read-only
repository analysis, managed background jobs, and private local usage reporting.

This directory is the Kimi source nested under `plugins/kimi`. It is the only
provider package in this repository and is published as
`kimi@model-companions-kimi`.

## Requirements and setup

- Git
- Node.js 18.18 or newer
- Claude Code 2.1.169 or newer
- Kimi Code 0.29.0 or newer
- Linux or macOS. Continuous integration does not cover Windows, so treat the
  Windows paths below as untested and run the plugin under WSL instead.

Install and authenticate Kimi Code using the
[official documentation](https://www.kimi.com/code/docs/en/):

```bash
kimi login
```

Load this directory directly while developing:

```bash
claude --plugin-dir /path/to/kimi
```

Then run:

```text
/kimi:setup
```

`/kimi:setup` runs `kimi --version`, verifies the `--agent-file`, `--skills-dir`,
and `--add-dir` capabilities used for tool-constrained workflows, and runs
`kimi doctor`. `/kimi:models` shows the
built-in profiles alongside models reported by the configured CLI, while
`/kimi:config` shows the companion’s effective configuration with sensitive
values redacted. Each accepts `--json`; none starts a model inference.
Only a delegated request confirms authentication.

## Commands

Delegation commands accept these arguments:

```text
/kimi:ask [--background] [--model <model> | --profile <profile>]
  [--label <label>] [--timeout <duration>] <task>
/kimi:explore [--background] [--model <model> | --profile <profile>]
  [--label <label>] [--timeout <duration>] <question>
/kimi:plan [--background] [--model <model> | --profile <profile>]
  [--label <label>] [--timeout <duration>] <objective>
/kimi:review [--background] [--base <ref>]
  [--model <model> | --profile <profile>]
  [--preset correctness|security|performance|api|tests]
  [--label <label>] [--timeout <duration>] [focus]
```

Inspection, job, usage, and session commands accept these arguments:

```text
/kimi:models [--json]
/kimi:config [--json]
/kimi:status [job-id] [--active | --all] [--limit <n>] [--json]
/kimi:result [job-id] [--wait] [--timeout <duration>] [--json]
/kimi:cancel [job-id] [--json]
/kimi:usage [--local] [--json] [--window today|24h|7d|30d|all]
  [--scope repo|all] [--group-by day|model|kind|outcome]
/kimi:cleanup --older-than <duration> [--scope repo|all]
  [--dry-run | --confirm] [--json]
/kimi:session --experimental list [--json]
/kimi:session --experimental start
  [--model <model> | --profile <profile>] [--json] <prompt>
/kimi:session --experimental continue <session-id> [--json] <prompt>
/kimi:session --experimental fork <session-id> [--json]
/kimi:setup [--json]
```

Options must precede task, question, objective, or focus text. Use `--` when the
text itself begins with a flag. Durations accept a positive integer followed by
`ms`, `s`, `m`, `h`, or `d`, such as `250ms`, `90s`, `20m`, `2h`, or `30d`.
A unitless duration means seconds. Run and result-wait timeouts allow at most 24
hours. Cleanup ages allow at most 10 years.

### Models and profiles

Use `--model` for an explicit Kimi model identifier or `--profile` for a stable
companion alias. The two options are mutually exclusive.

| Profile | Kimi model |
| --- | --- |
| `fast` | `kimi-for-coding-highspeed` |
| `stable` | `kimi-for-coding` |
| `deep` | `k3-256k` |
| `large-context` | `k3` |

Profiles select a model; they do not change isolation, permissions, or retry
behavior. Model availability still depends on the current Kimi account and CLI
configuration. Omit both selectors to use the Kimi CLI’s configured default.
`/kimi:models` reports both the fixed profile mapping and the configured CLI’s
model view. The companion does not parse Kimi credential files.

### Delegation and read-only modes

`/kimi:ask` is the autonomous implementation mode. Kimi runs in the repository
and may use its print-mode coding tools, so use it only in a checkout you trust.

`/kimi:explore` answers repository questions through an isolated custom agent.
`/kimi:plan` uses the same read-only boundary but asks for a concrete
implementation plan. Their tool allowlist contains only `Read`, `Grep`, and
`Glob`; the request-local agent does not grant Bash, write tools, MCP tools, or
user skills.

`/kimi:review` is stricter. The wrapper precomputes hardened Git status and diff
context, then runs Kimi in a request-local directory with an empty tool
allowlist and empty skills directory. The reviewer is not granted tools that
inspect or modify the checkout. The wrapper applies one aggregate byte budget
to all captured status, diff, and untracked-file context. It adds machine-readable
per-section truncation metadata to the request when any source capture or the
aggregate context is truncated. `--preset` selects a standard review lens;
optional focus text can narrow it further.

All four modes support background execution, explicit model selection, and a
provider execution deadline. `--label` stores a short operator label with a
background job so it is easier to identify in status output. `--timeout` stops
the managed provider process group when its deadline expires; it does not cause
an automatic retry.

For example:

```text
/kimi:ask --background --profile fast --timeout 20m Fix the parser
/kimi:explore --profile large-context Where is authorization enforced?
/kimi:plan --profile deep Add resumable uploads without changing the public API
/kimi:review --base main --preset security Focus on tenant isolation
```

### Runtime limits

The companion reads these settings when each command starts. Invalid values
fail closed with `INVALID_ARGUMENT`.

| Variable | Default | Accepted range |
| --- | ---: | ---: |
| `KIMI_COMPANION_MAX_CONCURRENCY` | `4` | `1`-`32` runs |
| `KIMI_COMPANION_MAX_OUTPUT_BYTES` | `16777216` (16 MiB) | `1024`-`1073741824` bytes |
| `KIMI_COMPANION_MAX_REVIEW_CONTEXT_BYTES` | `4194304` (4 MiB) | `65536`-`67108864` bytes |
| `KIMI_COMPANION_RUN_TIMEOUT` | `30m` | positive duration up to `24h` |

`/kimi:config` reports the effective values. A background job stores its output
limit and execution timeout when it starts. Later configuration changes do not
make that job’s retained result unreadable or change its execution cap. The 1
MiB result-rendering preview remains separate from the retained-artifact cap.

### Background jobs

Kimi scopes background jobs to the current Git repository. They retain the
existing Kimi state namespace, so upgrades preserve visibility of older jobs.
`/kimi:status` shows the 10 most recent jobs across statuses by default.
`--active` filters to active jobs, `--all` removes the default limit for the
current repository, and `--limit` applies an explicit cap. `--active` and
`--all` are mutually exclusive.

`/kimi:result` returns a terminal job’s retained output. Add `--wait` to wait for
an active job and optionally bound that observation with `--timeout`. A result
wait timeout leaves the provider and background job running; it is separate
from the execution timeout supplied when the job was started. Retained
artifacts may be larger than a safe MCP response, so result rendering returns a
combined 1 MiB preview. JSON includes exact total/returned byte counts and
per-artifact truncation flags under `data.artifacts`; the private retained files
are not modified by previewing them.

An omitted ID makes status list recent jobs and makes result select the most
recent job. Cancel is more conservative: `/kimi:cancel` may omit the ID only
when exactly one job is active. Cancellation waits for confirmed guard and
managed provider-group cleanup before reporting success. Status, result, and
cancel accept `--json` for automation.

JSON output uses the v2 envelope. Retrieving any terminal job is a successful
result operation and exits zero with `data.job.status`, including `failed`,
`cancelled`, `timed_out`, and `output_limit` jobs. Command failures, such as an
unknown job, an active job without `--wait`, or a result-wait timeout, exit
nonzero and return the v2 `error` envelope instead of `data`.

### Usage and cleanup

`/kimi:usage` reports private local companion activity only. It defaults to the
current repository over a rolling seven-day window; `--scope all` aggregates
all local Kimi companion workspaces without revealing their paths. `today` is
the current local calendar day, while `24h`, `7d`, and `30d` are rolling
windows. `--group-by` adds day, requested-model, kind, or outcome breakdowns.
`--json` returns the structured report, and `--local` is an explicit alias for
the default non-billable mode. Usage filters accept both `--window 24h` and
`--window=24h` forms, with the same convention for `--scope` and `--group-by`.

The I/O figures are UTF-8 byte counts, not token estimates. Kimi print mode
does not expose documented structured token usage, so the report marks provider
token usage unavailable instead of inferring it. Kimi Code also does not expose
membership quota through a supported noninteractive command or public headless
API. To inspect weekly and rolling limits, run `/usage` inside the native Kimi
Code TUI or visit the
[official Kimi Code Console](https://www.kimi.com/code/console). The plugin does
not read Kimi credential files, call undocumented quota endpoints, scrape the
TUI, open a browser, or launch a dummy prompt.

`/kimi:cleanup` manages the plugin’s retained local state. It is a dry run by
default and requires both `--older-than` and `--confirm` before deletion. It
reports terminal job metadata/artifacts and usage-ledger records as separate
categories. Active jobs are never eligible. `--scope all` spans local Kimi
workspaces; it does not affect another companion package or Kimi’s own session
store. A confirmed cleanup with any removal failure exits nonzero in both human
and JSON modes; JSON failures use the v2 `error` envelope.

```text
/kimi:cleanup --older-than 30d
/kimi:cleanup --older-than 30d --confirm
```

### Recover interrupted runs

Run `/kimi:usage`, `/kimi:status`, `/kimi:setup`, or a confirmed cleanup to
recover an abandoned foreground manifest after its owner and provider guard
have exited. The companion verifies the manifest, finalizes its usage record as
`interrupted`, releases its concurrency slot, and removes only the artifacts
named by that manifest. A cleanup dry run never performs recovery.

The same commands recover a background launch that stopped before durable job
handoff. The companion validates its provisional manifest and linked usage
record, removes its prompt and concurrency slot, and records the launch as
`interrupted`. If durable job metadata exists, that job owns the remaining
lifecycle and recovery removes the redundant provisional manifest. Recovery also
removes exact-target atomic-write temporaries linked to the stopped manifest,
but only after its recorded owner has exited and each temporary remains a
stable private regular file. Unknown or lookalike files remain as fail-closed
evidence.

A crash before the provisional manifest itself is published can leave an
unpublished provisional-manifest temporary named like
`kimi-<timestamp>-<suffix>.provision.json.<pid>.<suffix>.tmp`. It contains recovery
metadata, including the workspace path, but no delegated prompt, provider
output, or provider credentials. The companion does not delete this file
because no published manifest authenticates its ownership. Inspect the private
state root, verify that the recorded process is no longer running, and remove
only that exact temporary by hand.

If recovery returns `FOREGROUND_MANIFEST_INVALID`,
`FOREGROUND_RECOVERY_UNSAFE`, `BACKGROUND_PROVISION_LINK_INVALID`,
`CLEANUP_UNSAFE_ARTIFACTS`, or `STATE_PATH_UNSAFE`, stop and inspect the
configured private state root. Remove an unexpected symlink or restore the
original owner and permissions before retrying. Do not delete a live guard,
worker, slot, or job record by hand. Use `/kimi:cancel <job-id>` for a live
background job and wait for confirmed termination.

### Experimental native sessions

`/kimi:session` is an explicit opt-in bridge to Kimi’s documented Agent Client
Protocol (ACP) session lifecycle. Every invocation must include
`--experimental`; the flag is not remembered. Session start and continue run in
the foreground and configure ACP with `mcpServers: []`, so the companion does
not pass Claude Code’s MCP servers into the nested Kimi session. User-level MCP
startup configured directly in Kimi remains outside this control.

`start` creates a Kimi-native session and sends its first prompt. It accepts the
same mutually exclusive `--model` and `--profile` selectors as other run modes.
`continue` resumes the named Kimi session and sends another prompt. `list`
reports sessions visible through the supported interface. Kimi persists native
session history in its own store. The companion’s usage ledger retains only
operational counts for start/continue turns and does not create another copy of
the prompt or store session IDs.

`fork` is exposed for forward compatibility but is not emulated. The command
capability-probes the installed Kimi CLI and fails closed while upstream ACP
reports the lifecycle extension as unimplemented. It never turns a slash
command into a model prompt and never copies Kimi session files. These session
commands are experimental because ACP lifecycle support and response shapes may
change independently of the stable job commands.

## Security model

Slash-command text is transported as a JSON string through MCP and never
interpolated into a shell command. The runtime resolves and executes the Kimi
binary with an argv array. Model and configuration inspection redact sensitive
values and do not expose provider credentials.

Each slash command removes Claude Code’s built-in tools for that invocation and
uses a bounded, fail-closed `PreToolUse` gate to permit only the single
package-namespaced Kimi companion tool declared by the command. If hooks are
disabled by local or managed Claude Code policy, the companion tool falls back
to that policy’s normal permission decision instead of receiving an automatic
grant.

Each read-only request creates its own custom-agent and empty-skills boundary.
Explore and plan can read repository files through their narrow tool allowlist;
review sees only the precomputed Git context. Both modes treat repository
content as untrusted data.

This is a tool boundary, not an operating-system sandbox. The documented Kimi
CLI does not expose a switch that disables existing user-level hooks or MCP
startup configuration. Such configuration may launch local code before or
outside an agent tool call, so it remains trusted. For strict isolation, use a
dedicated Kimi configuration/home with no hooks or user MCP servers, or run the
plugin inside an OS/container sandbox.

Background providers run behind a detached guard. Cancellation and execution
timeouts require confirmed cleanup of the managed process group before the
companion reports a terminal state. Concurrency leases and cancellation
controls remain available until the companion confirms cleanup, so a later
cancel or status operation can recover the retained guard. The companion caps
provider output before writing it to disk, and
companion-authored diagnostics share that same combined artifact cap. Stored job
job errors get redacted, terminal-control-normalized, and independently bounded.

The provider process receives only the documented Kimi configuration channels
needed for model access, network routing, and Windows Git Bash discovery. The
companion forces telemetry, scheduled tasks, auto-update work, background-task
keep-alive, and nested background concurrency to safe values for delegated
runs: schedules and updates stay disabled, nested tasks do not survive provider
exit, and at most one nested background task runs at a time.

The guard is lifecycle control, not an OS sandbox. On POSIX it covers
descendants that remain in the launched process group. Portable Node.js cannot
reliably identify or terminate a child that deliberately daemonizes or creates
a new session; analogous breakaway behavior exists on other platforms. Use a
container, virtual machine, cgroup/job boundary, or another OS sandbox when you
need hard containment of untrusted subprocesses.

Foreground tasks and experimental session turns keep a strict private recovery
manifest until managed-group cleanup and local usage accounting both finish. If
the owning Claude Code process exits unexpectedly, the detached owner-leased
guard terminates the tracked provider group; a later usage, status, setup, or
confirmed cleanup request then records the run as interrupted and removes only the
manifest-derived artifacts and concurrency lease. ACP operations and provider
probes use the same owner-leased stdio guard on every platform. Cleanup dry runs
do not run this recovery or otherwise mutate retained state.

State directories reject symbolic links and non-directory components at every
existing component below a trusted filesystem-root alias. Dry-run cleanup does
not create or repair state. On POSIX, the companion creates managed directories
with mode `0700`, creates files with mode `0600`, and rejects unsafe owners or
group/world-writable state during reads. It publishes metadata with synced
same-directory atomic replacement; create-only records use an atomic
no-clobber publish.

Generic metadata locks protect concurrency, jobs, usage records, foreground manifests, and background provisioning. Each lock is a private, nonempty directory with a strict `owner.json` identity. Where the platform and filesystem support it, the companion syncs a complete off-path directory before publishing it with a no-clobber rename. Normal release retires that directory under its owner token, validates the same identity, and removes it without residue.

Recovery scans every generic Kimi lock store, including orphaned locks whose related metadata was deleted. A dead-owner retirement remains as evidence without blocking a replacement owner. Recovery never takes over a live process based on age. It requires either a dead process identifier or a verified process-birth mismatch. When the platform cannot verify process birth, a live process keeps the lock busy.

An unexpected lock file, symbolic link, incomplete directory, malformed `owner.json`, or missing lock during release returns `STATE_LOCK_UNSAFE`. Stop every confirmed owner process, preserve the private state root, and remove only the named invalid lock entry before retrying. A zero-byte legacy `.lock` file is invalid and is never treated as an available lock.

On Windows, Node’s mode flags do not establish or verify a private DACL. The
companion inherits the DACL on `CLAUDE_PLUGIN_DATA` or
`MODEL_COMPANION_STATE_DIR`; it does not configure or audit that ACL. Point the
state variable at a directory accessible only to your Windows account before
running delegated prompts. `/kimi:config --json` reports this platform contract
under `data.privacy.stateProtection`.

Kimi’s own native session store is managed by Kimi Code and may contain session
prompts and responses.

Local usage records contain only operational metadata and byte counts. They do
not contain prompt/output/diagnostic text, repository paths, credentials, PIDs,
or worker tokens. The companion derives aggregates at query time. A job whose
usage record is missing stays readable through `/kimi:status` and `/kimi:result`
but does not count toward the aggregates, and `/kimi:usage` reports that
exclusion in its coverage fields.

On POSIX systems, ambient Kimi and Git lookup accepts only non-empty absolute
`PATH` directories and rejects candidates whose canonical target is inside the
current workspace/repository. Provider executables must be owned by root or the
current user, with no group/world write access on the executable or its
canonical parent directories. `KIMI_BIN` is an explicit operator opt-in: when
set, it must be an absolute path and still passes the ownership/mode checks,
but it may intentionally name a workspace-local executable.

The Windows code paths are present but untested: no automated suite runs on
Windows, so the behavior described here is unverified. Run the plugin under
WSL. Where the Windows paths do run, only native `.exe` or `.com` providers
are accepted. The npm `.cmd` shim and other batch wrappers stay unsupported
because their arguments would otherwise cross a command shell.

The plugin manifest and command hooks necessarily launch a bare `node` before
these runtime checks can execute. The Node executable and Claude Code’s
inherited `PATH` used to start plugin components are therefore trusted. These
provenance checks reduce workspace-PATH substitution risk; they are not an OS
sandbox or a substitute for a trusted Claude Code launch environment.

## Development

From this directory:

```bash
npm test
npm run validate
```

The package tests include an installed-cache smoke test.
