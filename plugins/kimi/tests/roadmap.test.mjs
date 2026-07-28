import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  createChangedRepository,
  fakeEnvironment,
  findFile,
  mcpExchange,
  parseJsonLines,
  pluginRoot,
  poll,
  run,
  runtime,
  temporaryDirectory
} from "./helpers.mjs";

const packageVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;

function readEnvelope(result, command, expectedStatus = 0) {
  assert.equal(result.status, expectedStatus, `${result.stdout}\n${result.stderr}`);
  const document = JSON.parse(result.stdout);
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.provider, "kimi");
  assert.equal(document.command, command);
  assert.ok(Number.isFinite(Date.parse(document.generatedAt)));
  return document;
}

function usageFiles(temporary) {
  const root = path.join(temporary, "state", "model-companions", "kimi", "workspaces");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((workspace) => {
    const directory = path.join(root, workspace.name, "usage");
    if (!workspace.isDirectory() || !fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(directory, name));
  });
}

function jobId(result) {
  const id = result.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id, result.stdout);
  return id;
}

test("models, config, and setup expose redacted v2 automation documents", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const missing = fakeEnvironment(temporary, {
    KIMI_BIN: path.join(temporary, "missing-kimi"),
    KIMI_BIN_ARGS_JSON: "[]",
    AWS_SECRET_ACCESS_KEY: "unrelated-secret"
  });

  const models = readEnvelope(run(["models", "--json"], { cwd: repository, env: missing }), "models").data;
  assert.deepEqual(Object.fromEntries(models.profiles.map((profile) => [profile.name, profile.model])), {
    fast: "kimi-for-coding-highspeed",
    stable: "kimi-for-coding",
    deep: "k3-256k",
    "large-context": "k3"
  });
  assert.equal(models.configured.available, false);

  const configDocument = readEnvelope(run(["config", "--json"], { cwd: repository, env: missing }), "config");
  assert.equal(configDocument.data.version, packageVersion);
  assert.equal(configDocument.data.limits.concurrency, 4);
  assert.equal(configDocument.data.providerConfiguration.available, false);
  assert.doesNotMatch(JSON.stringify(configDocument), /unrelated-secret/);

  const configured = readEnvelope(run(["models", "--json"], { cwd: repository, env: fakeEnvironment(temporary) }), "models");
  assert.equal(configured.data.configured.models[0].alias, "kimi-test");
  assert.doesNotMatch(JSON.stringify(configured), /must-not-be-returned|credentials|token/);

  const setup = readEnvelope(run(["setup", "--json"], { cwd: repository, env: fakeEnvironment(temporary) }), "setup");
  assert.equal(setup.data.billableModelRequestMade, false);
  assert.equal(setup.data.authenticationVerified, false);
  assert.match(setup.data.workflowBoundary, /hooks and MCP startup configuration remain trusted/i);

  const response = await mcpExchange({
    messages: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "models", arguments: { rawArguments: "--json" } } }
    ],
    responseId: 2,
    env: missing,
    cwd: repository
  });
  const tool = parseJsonLines(response.stdout).find((message) => message.id === 2).result;
  assert.deepEqual(tool.structuredContent, JSON.parse(tool.content[0].text));
});

test("profiles, review presets, and tool-constrained workflows use explicit hardened invocations", () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const shellPath = path.join(temporary, "Git", "bin", "bash.exe");
  const localAppData = path.join(temporary, "LocalAppData");
  const secretEnvironment = fakeEnvironment(temporary, {
    AWS_SECRET_ACCESS_KEY: "must-be-scrubbed",
    OPENAI_API_KEY: "also-scrubbed",
    KIMI_MODEL_API_KEY: "required-kimi-channel",
    KIMI_SHELL_PATH: shellPath,
    LOCALAPPDATA: localAppData,
    KIMI_DISABLE_CRON: "0",
    KIMI_CODE_NO_AUTO_UPDATE: "0",
    KIMI_CLI_NO_AUTO_UPDATE: "0",
    KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "1",
    KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS: "99",
    FAKE_REQUIRED_ENV_JSON: JSON.stringify({
      KIMI_SHELL_PATH: shellPath,
      LOCALAPPDATA: localAppData,
      KIMI_DISABLE_CRON: "1",
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_CLI_NO_AUTO_UPDATE: "1",
      KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "0",
      KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS: "1"
    })
  });

  const task = run(["run", "task", "--profile", "stable", "implement", "it"], { cwd: repository, env: secretEnvironment });
  assert.equal(task.status, 0, task.stderr);
  const taskRecord = JSON.parse(task.stdout);
  assert.equal(taskRecord.args[taskRecord.args.indexOf("--model") + 1], "kimi-for-coding");
  assert.equal(taskRecord.environmentKeys.includes("AWS_SECRET_ACCESS_KEY"), false, "ask must not inherit unrelated ambient credentials");
  assert.equal(taskRecord.environmentKeys.includes("OPENAI_API_KEY"), false);
  assert.equal(taskRecord.environmentKeys.includes("KIMI_MODEL_API_KEY"), true);
  assert.equal(taskRecord.environmentKeys.includes("KIMI_SHELL_PATH"), true);
  assert.equal(taskRecord.environmentKeys.includes("LOCALAPPDATA"), true);
  assert.equal(taskRecord.environmentKeys.includes("KIMI_DISABLE_CRON"), true);
  assert.equal(taskRecord.environmentKeys.includes("KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT"), true);

  const explore = run(["run", "explore", "--profile", "large-context", "find", "the", "boundary"], { cwd: repository, env: secretEnvironment });
  assert.equal(explore.status, 0, explore.stderr);
  const exploreRecord = JSON.parse(explore.stdout);
  assert.equal(exploreRecord.args[exploreRecord.args.indexOf("--model") + 1], "k3");
  assert.equal(exploreRecord.args[exploreRecord.args.indexOf("--agent-file") + 1], path.join(pluginRoot, "assets", "kimi-explorer.md"));
  assert.equal(exploreRecord.args[exploreRecord.args.indexOf("--add-dir") + 1], fs.realpathSync(repository));
  assert.equal(exploreRecord.environmentKeys.includes("AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(exploreRecord.environmentKeys.includes("OPENAI_API_KEY"), false);
  assert.equal(exploreRecord.environmentKeys.includes("KIMI_MODEL_API_KEY"), true);
  assert.notEqual(exploreRecord.cwdReal, fs.realpathSync(repository));
  assert.match(exploreRecord.prompt, /User request:\nfind the boundary/);

  const plan = run(["run", "plan", "--profile", "deep", "plan", "a", "migration"], { cwd: repository, env: secretEnvironment });
  assert.equal(plan.status, 0, plan.stderr);
  const planRecord = JSON.parse(plan.stdout);
  assert.equal(planRecord.args[planRecord.args.indexOf("--model") + 1], "k3-256k");
  assert.equal(planRecord.args[planRecord.args.indexOf("--agent-file") + 1], path.join(pluginRoot, "assets", "kimi-planner.md"));

  const review = run(["run", "review", "--preset", "security", "tenant", "isolation"], { cwd: repository, env: secretEnvironment });
  assert.equal(review.status, 0, review.stderr);
  const reviewRecord = JSON.parse(review.stdout);
  assert.match(reviewRecord.prompt, /Review preset: security\./);
  assert.match(reviewRecord.prompt, /exploitable security weaknesses/);

  const removedWait = run(["run", "task", "--wait", "do", "work"], { cwd: repository, env: secretEnvironment });
  assert.notEqual(removedWait.status, 0);
  assert.match(removedWait.stderr, /Unknown run option: --wait/);
  const ambiguousModel = run(["run", "task", "--profile", "fast", "--model", "kimi-test", "work"], { cwd: repository, env: secretEnvironment });
  assert.notEqual(ambiguousModel.status, 0);
  assert.match(ambiguousModel.stderr, /mutually exclusive/);
});

test("JSON-mode MCP failures return the same v2 envelope as text and structuredContent", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { KIMI_BIN: path.join(temporary, "missing-kimi") });
  for (const [name, rawArguments, code] of [["status", "--json", "JOB_NOT_FOUND"], ["result", "--json", "JOB_NOT_FOUND"], ["cancel", "--json", "JOB_NOT_FOUND"]]) {
    const exchange = await mcpExchange({
      messages: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { rawArguments } } }
      ],
      responseId: 2,
      env,
      cwd: repository
    });
    const result = parseJsonLines(exchange.stdout).find((message) => message.id === 2).result;
    assert.equal(result.isError, true);
    const textDocument = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, textDocument);
    assert.equal(textDocument.schemaVersion, 2);
    assert.equal(textDocument.provider, "kimi");
    assert.equal(textDocument.command, name);
    assert.equal(textDocument.error.code, code);
    assert.equal(Object.hasOwn(textDocument, "data"), false);
  }

  const invalid = readEnvelope(run(["result", "not-a-job", "--json"], { cwd: repository, env }), "result", 1);
  assert.equal(invalid.error.code, "INVALID_ARGUMENT");

  const workspaces = path.join(temporary, "state", "model-companions", "kimi", "workspaces");
  const workspace = fs.readdirSync(workspaces, { withFileTypes: true }).find((entry) => entry.isDirectory());
  const corruptId = "kimi-corrupt-deadbeef";
  fs.writeFileSync(path.join(workspaces, workspace.name, "jobs", `${corruptId}.json`), "{", { mode: 0o600 });
  const corrupt = readEnvelope(run(["result", corruptId, "--json"], { cwd: repository, env }), "result", 1);
  assert.equal(corrupt.error.code, "JOB_METADATA_INVALID");
});

test("managed job filters, labels, result waiting, and cancellation ambiguity are safe", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const delayed = fakeEnvironment(temporary, { FAKE_PROVIDER_DELAY_MS: "700" });
  const started = run(["run", "task", "--background", "--profile", "fast", "--label", "parser-fix", "--timeout", "5s", "quick"], { cwd: repository, env: delayed });
  assert.equal(started.status, 0, started.stderr);
  const id = jobId(started);

  const active = readEnvelope(run(["status", "--active", "--limit", "1", "--json"], { cwd: repository, env: delayed }), "status").data;
  assert.equal(active.jobs[0].id, id);
  assert.equal(active.jobs[0].label, "parser-fix");
  assert.equal(active.jobs[0].profile, "fast");
  assert.equal(active.jobs[0].model, "kimi-for-coding-highspeed");
  assert.equal(active.filters.active, true);

  const result = readEnvelope(run(["result", id, "--wait", "--timeout", "5s", "--json"], { cwd: repository, env: delayed, timeout: 10_000 }), "result").data;
  assert.equal(result.job.status, "finished");
  assert.match(result.output, /"prompt":"quick"/);
  const all = readEnvelope(run(["status", "--all", "--limit", "1", "--json"], { cwd: repository, env: delayed }), "status").data;
  assert.equal(all.jobs.length, 1);

  const waiting = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait" });
  const first = jobId(run(["run", "task", "--background", "first", "wait"], { cwd: repository, env: waiting }));
  const second = jobId(run(["run", "task", "--background", "second", "wait"], { cwd: repository, env: waiting }));
  const ambiguous = readEnvelope(run(["cancel", "--json"], { cwd: repository, env: waiting }), "cancel", 1);
  assert.equal(ambiguous.error.code, "AMBIGUOUS_JOB");
  for (const activeId of [first, second]) {
    const cancelled = readEnvelope(run(["cancel", activeId, "--json"], { cwd: repository, env: waiting, timeout: 15_000 }), "cancel");
    assert.equal(cancelled.data.job.status, "cancelled");
  }
});

test("execution timeout and output limit become distinct terminal job outcomes", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();

  const timedEnvironment = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait" });
  const timedId = jobId(run(["run", "task", "--background", "--timeout", "100ms", "time", "out"], { cwd: repository, env: timedEnvironment }));
  await poll(() => /\ttimed_out\t/.test(run(["status", timedId], { cwd: repository, env: timedEnvironment }).stdout), 15_000);
  const timedResult = run(["result", timedId], { cwd: repository, env: timedEnvironment });
  assert.equal(timedResult.status, 0);

  const outputEnvironment = fakeEnvironment(temporary, {
    FAKE_PROVIDER_STDOUT_BYTES: "4096",
    KIMI_COMPANION_MAX_OUTPUT_BYTES: "1024"
  });
  const outputId = jobId(run(["run", "task", "--background", "too", "much", "output"], { cwd: repository, env: outputEnvironment }));
  await poll(() => /\toutput_limit\t/.test(run(["status", outputId], { cwd: repository, env: outputEnvironment }).stdout), 25_000);
  const metadataPath = findFile(path.join(temporary, "state"), `${outputId}.json`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const retainedBytes = [metadata.outputPath, metadata.errorPath].reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
  assert.ok(retainedBytes <= 1024, `retained ${retainedBytes} bytes`);

  const usage = readEnvelope(run(["usage", "--json", "--window=all", "--group-by", "outcome"], { cwd: repository, env: fakeEnvironment(temporary) }), "usage").data;
  assert.equal(usage.aggregates.outcomes.timed_out, 1);
  assert.equal(usage.aggregates.outcomes.output_limit, 1);
  assert.deepEqual(usage.grouping.groups.map((group) => group.key), ["output_limit", "timed_out"]);
});

test("cleanup previews job artifacts and usage records separately and never deletes active jobs", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);
  const finishedId = jobId(run(["run", "task", "--background", "finished"], { cwd: repository, env }));
  await poll(() => /\tfinished\t/.test(run(["status", finishedId], { cwd: repository, env }).stdout));
  const activeEnvironment = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait" });
  const activeId = jobId(run(["run", "task", "--background", "active"], { cwd: repository, env: activeEnvironment }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const missingProvider = fakeEnvironment(temporary, { KIMI_BIN: path.join(temporary, "missing-kimi") });
  const preview = readEnvelope(run(["cleanup", "--older-than", "1ms", "--dry-run", "--json"], { cwd: repository, env: missingProvider }), "cleanup").data;
  assert.equal(preview.dryRun, true);
  assert.ok(preview.jobs.eligible >= 1);
  assert.ok(preview.usageRecords.eligible >= 1);
  assert.equal(preview.jobs.removed, 0);
  assert.equal(preview.usageRecords.removed, 0);
  assert.equal(preview.activeJobsRemoved, 0);

  const removed = readEnvelope(run(["cleanup", "--older-than", "1ms", "--confirm", "--json"], { cwd: repository, env: missingProvider }), "cleanup").data;
  assert.ok(removed.jobs.removed >= 1);
  assert.ok(removed.usageRecords.removed >= 1);
  assert.equal(removed.activeJobsRemoved, 0);
  assert.equal(run(["status", activeId], { cwd: repository, env: activeEnvironment }).status, 0);
  assert.notEqual(run(["status", finishedId], { cwd: repository, env }).status, 0);
  assert.equal(run(["cancel", activeId], { cwd: repository, env: activeEnvironment, timeout: 15_000 }).status, 0);
});

test("experimental ACP sessions are opted in, permission-denying, bounded, and locally accounted", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "acp.json");
  const secretPrompt = "SESSION_PRIVATE_PROMPT";
  const env = fakeEnvironment(temporary, {
    FAKE_ACP_PERMISSION: "1",
    FAKE_RECORD_FILE: recordFile,
    AWS_SECRET_ACCESS_KEY: "scrub-this",
    KIMI_MODEL_API_KEY: "keep-this"
  });

  const noOptIn = run(["session", "start", "hello"], { cwd: repository, env });
  assert.notEqual(noOptIn.status, 0);
  assert.match(noOptIn.stderr, /--experimental opt-in/);

  const started = readEnvelope(run(["session", "--experimental", "start", "--profile", "deep", "--json", secretPrompt], { cwd: repository, env }), "session").data;
  assert.equal(started.sessionId, "session-new");
  assert.equal(started.output, "fake session response");
  const recorded = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const created = recorded.requests.find((request) => request.method === "session/new");
  assert.deepEqual(created.params.mcpServers, []);
  const selected = recorded.requests.find((request) => request.method === "session/set_config_option");
  assert.deepEqual(selected.params, { sessionId: "session-new", configId: "model", value: "k3-256k" });
  const denied = recorded.requests.find((request) => request.id === 10_000 && request.result);
  assert.deepEqual(denied.result, { outcome: { outcome: "cancelled" } });
  assert.equal(recorded.environmentKeys.includes("AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(recorded.environmentKeys.includes("KIMI_MODEL_API_KEY"), true);

  const ledger = usageFiles(temporary).map((file) => ({ file, source: fs.readFileSync(file, "utf8") }));
  const sessionRecord = ledger.map((entry) => JSON.parse(entry.source)).find((record) => record.kind === "session");
  assert.equal(sessionRecord.requestedModel, "k3-256k");
  assert.equal(sessionRecord.outcome, "finished");
  assert.ok(sessionRecord.bytes.output > 0);
  assert.equal(ledger.some((entry) => entry.source.includes(secretPrompt)), false);
  assert.equal(ledger.some((entry) => entry.source.includes("session-new")), false);

  const continued = readEnvelope(run(["session", "--experimental", "continue", "session-listed", "--json", "follow", "up"], { cwd: repository, env }), "session").data;
  assert.equal(continued.action, "continue");
  assert.equal(continued.sessionId, "session-listed");
  const continuedRequests = JSON.parse(fs.readFileSync(recordFile, "utf8")).requests;
  assert.deepEqual(continuedRequests.find((request) => request.method === "session/resume").params, {
    sessionId: "session-listed",
    cwd: fs.realpathSync(repository),
    mcpServers: []
  });

  const listed = readEnvelope(run(["session", "--experimental", "list", "--json"], { cwd: repository, env }), "session").data;
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].sessionId, "session-listed");
  assert.equal(listed.nextCursor, "next-page");

  const forked = readEnvelope(run(["session", "--experimental", "fork", "session-new", "--json"], { cwd: repository, env }), "session", 1);
  assert.equal(forked.error.code, "ACP_FORK_UNSUPPORTED");

  const limited = readEnvelope(run(["session", "--experimental", "start", "--json", "bounded"], {
    cwd: repository,
    env: fakeEnvironment(temporary, { FAKE_ACP_OUTPUT_BYTES: "2048", KIMI_COMPANION_MAX_OUTPUT_BYTES: "1024" }),
    timeout: 10_000
  }), "session", 1);
  assert.equal(limited.error.code, "OUTPUT_LIMIT");
  const records = usageFiles(temporary).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  assert.equal(records.filter((record) => record.kind === "session" && record.outcome === "output_limit").length, 1);

  const closedAt = Date.now();
  const closed = readEnvelope(run(["session", "--experimental", "start", "--json", "close"], {
    cwd: repository,
    env: fakeEnvironment(temporary, { FAKE_ACP_MODE: "close" }),
    timeout: 8_000
  }), "session", 1);
  assert.equal(closed.error.code, "ACP_CLOSED");
  assert.ok(Date.now() - closedAt < 6_000, "closed ACP requests should not wait for the request timeout");

  const cancelRecord = path.join(temporary, "cancel-acp.json");
  const child = spawn(process.execPath, [runtime, "mcp"], {
    cwd: repository,
    env: fakeEnvironment(temporary, { FAKE_ACP_MODE: "hang", FAKE_RECORD_FILE: cancelRecord }),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session", arguments: { rawArguments: "--experimental start hang" } } })}\n`);
  await poll(() => {
    try {
      const record = JSON.parse(fs.readFileSync(cancelRecord, "utf8"));
      return record.requests.some((request) => request.method === "session/prompt");
    } catch { return false; }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test" } })}\n`);
  await poll(() => stdout.split("\n").some((line) => {
    try { return JSON.parse(line).id === 2; } catch { return false; }
  }), 8_000);
  child.stdin.end();
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`ACP MCP did not close: ${stderr}`)), 8_000))
  ]);
  assert.equal(exitCode, 0, stderr);
  const cancelled = parseJsonLines(stdout).find((message) => message.id === 2).result;
  assert.equal(cancelled.isError, true);
  assert.equal(cancelled.structuredContent.error.code, "ACP_CANCELLED");
});

test("documentation and package metadata describe the trusted hook boundary", () => {
  const readme = fs.readFileSync(path.join(pluginRoot, "README.md"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
  assert.match(readme, /tool boundary, not an operating-system sandbox/i);
  assert.match(readme, /user-level hooks or MCP\s+startup configuration/i);
  assert.doesNotMatch(readme, /enforced read-only/i);
  assert.match(manifest.description, /tool-constrained read-only/);
  assert.ok(packageJson.files.includes("CHANGELOG.md"));
  assert.match(fs.readFileSync(path.join(pluginRoot, "CHANGELOG.md"), "utf8"), /## 1\.0\.0/);
});

test("package README retains the repository writing invariants", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "README.md"), "utf8").replace(/\r\n?/g, "\n");
  const fenceFor = (line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    return match ? { marker: match[1], info: match[2] } : undefined;
  };
  let proseFence;
  const prose = source.split("\n").map((line) => {
    const fence = fenceFor(line);
    if (!proseFence && fence) {
      proseFence = fence.marker;
      return "";
    }
    if (proseFence) {
      if (fence && fence.marker[0] === proseFence[0]
          && fence.marker.length >= proseFence.length && fence.info.trim() === "") proseFence = undefined;
      return "";
    }
    return line.replace(/`+[^`]*`+/g, " ");
  }).join("\n");
  assert.doesNotMatch(prose, /\b(?:easy|simple|quick|very|just|really)\b/i);
  assert.doesNotMatch(prose, /—|\.\.\./);
  assert.doesNotMatch(prose, /\b[A-Za-z]+'(?:s|t|re|ve|ll|d|m)\b/);

  let openFence;
  let snippetLines = 0;
  for (const [index, line] of source.split("\n").entries()) {
    const fence = fenceFor(line);
    const closes = openFence && fence && fence.marker[0] === openFence[0]
      && fence.marker.length >= openFence.length && fence.info.trim() === "";
    if (!openFence && fence) {
      assert.match(fence.info, /^\S+$/, `README.md:${index + 1} code fence needs a language tag`);
      openFence = fence.marker;
      snippetLines = 0;
    } else if (closes) {
      assert.ok(snippetLines <= 25, `README.md:${index + 1} code block exceeds 25 lines`);
      openFence = undefined;
    } else if (openFence) {
      snippetLines += 1;
      assert.ok(line.length <= 80, `README.md:${index + 1} code line exceeds 80 columns`);
    }
  }
  assert.equal(openFence, undefined, "README.md has an unclosed code fence");
});
