---
meta:
  title: Maintain Kimi Code Companion documentation
  navLabel: Documentation Plan
  category: Contributing
  contentType: Conceptual
contentPlan: ./content-plan.md#documentation-plan
---

# Maintain Kimi Code Companion documentation

This plan defines the audience, purpose, and ownership of Kimi documentation. Keep each page active, direct, and focused on one reader task.

## Documentation plan

| Plan anchor | Page | Content type | Reader goal |
| --- | --- | --- | --- |
| `repository-landing` | `../README.md` | Landing | Install Kimi and find a guide |
| `documentation-home` | `./README.md` | Landing | Navigate by Kimi task |
| `get-started` | `./get-started.md` | Tutorial | Install, verify, and run read-only Kimi |
| `command-reference` | `./command-reference.md` | Reference | Look up Kimi syntax and boundaries |
| `manage-jobs-and-usage` | `./manage-jobs-and-usage.md` | How-to | Operate Kimi jobs, usage, and cleanup |
| `security-model` | `./security-model.md` | Conceptual | Explain Kimi trust and containment limits |
| `structured-output` | `./structured-output-v2.md` | Reference | Parse Kimi version-2 responses |
| `troubleshooting` | `./troubleshooting.md` | Troubleshooting | Diagnose Kimi setup and runtime failures |
| `release-packages` | `./release-packages.md` | How-to | Validate and release Kimi |

## Sources of truth

- Command frontmatter in `plugins/kimi/commands`
- Kimi runtime validation in `plugins/kimi/scripts/companion.mjs`
- Kimi package metadata and marketplace entry under `plugins/kimi`
- Kimi tests for contracts, security boundaries, packaging, and release behavior
- Official Kimi Code documentation for provider capabilities

## Repository landing

Keep the root README concise: install Kimi, state the marketplace identity, explain the private-state migration, and route readers to one guide.

## Documentation home

Group links by starting, operating, and maintaining the Kimi plugin. Do not duplicate command syntax or security rationale.

## Get started

Guide an operator from prerequisites through installation, local setup checks, and a first read-only request.

## Command reference

List every public Kimi command, its syntax, profiles, and execution boundary.

## Manage jobs and usage

Show how to start, inspect, cancel, recover, report, and clean Kimi retained work.

## Security model

Explain Kimi tool routing, startup configuration, process control, private state, executable trust, and the limits of containment.

## Structured output

Define the Kimi version-2 envelope, operation errors, terminal-job retrieval semantics, and MCP representation.

## Troubleshooting

Help an operator diagnose setup, executable trust, job recovery, and state-identity problems without exposing private data.

## Release packages

Guide maintainers through Kimi-only validation, versioning, packaging, and recovery.

## Migration rule

This is one of exactly two successor repositories to the former combined marketplace. Document only the Kimi install identity `model-companions-kimi`, source `plugins/kimi`, and Kimi workflows. Mention the old identity or the separate GLM repository only when it helps an operator protect private state during the `CLAUDE_PLUGIN_DATA` identity migration.
