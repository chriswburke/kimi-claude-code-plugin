import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANARY = "model-companion-contract-canary-secret";
const FIXTURES = {
  kimi: path.join(ROOT, "plugins", "kimi", "tests", "fixtures", "fake-kimi.mjs")
};
let kimiFixtureConfigCounter = 0;

function minimalEnvironment(overrides = {}) {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "SHELL", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

function trustedPosixNativeExecutable(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0) return undefined;
    fs.accessSync(resolved, fs.constants.X_OK);
    const trustedOwners = new Set([0]);
    if (typeof process.getuid === "function") trustedOwners.add(process.getuid());
    if (!trustedOwners.has(stat.uid)) return undefined;
    let directory = path.dirname(resolved);
    while (true) {
      const directoryStat = fs.statSync(directory);
      if (!directoryStat.isDirectory()
          || !trustedOwners.has(directoryStat.uid)
          || (directoryStat.mode & 0o022) !== 0) return undefined;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const descriptor = fs.openSync(resolved, "r");
    try {
      const prefix = Buffer.alloc(2);
      if (fs.readSync(descriptor, prefix, 0, prefix.length, 0) !== prefix.length
          || (prefix[0] === 0x23 && prefix[1] === 0x21)) return undefined;
    } finally {
      fs.closeSync(descriptor);
    }
    return resolved;
  } catch {
    return undefined;
  }
}

function trustedNodeLauncher(environment) {
  if (process.platform === "win32") return process.execPath;
  const candidates = [process.execPath];
  const pathText = environment.PATH || "";
  for (const directory of pathText.split(path.delimiter)) {
    if (directory && path.isAbsolute(directory)) candidates.push(path.join(directory, "node"));
  }
  for (const candidate of new Set(candidates)) {
    const trusted = trustedPosixNativeExecutable(candidate);
    if (!trusted) continue;
    const probe = spawnSync(trusted, ["-e", "process.stdout.write(JSON.stringify({execPath:process.execPath,node:process.versions.node}))"], {
      env: environment,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true
    });
    if (probe.status !== 0 || probe.error) continue;
    let identity;
    try { identity = JSON.parse(probe.stdout); } catch { continue; }
    const major = Number(String(identity?.node || "").split(".")[0]);
    if (!Number.isInteger(major) || major < 18 || typeof identity?.execPath !== "string" || !path.isAbsolute(identity.execPath)) continue;
    const runtime = trustedPosixNativeExecutable(identity.execPath);
    if (runtime) return runtime;
  }
  throw new Error("Kimi structured-output tests require a native Node launcher with a trusted ownership and permission chain.");
}

function stopCapturing(child) {
  for (const stream of [child?.stdout, child?.stderr]) {
    stream?.removeAllListeners("data");
    try { stream?.destroy(); } catch { /* Best-effort stream shutdown. */ }
  }
}

function waitForClose(child, milliseconds) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let complete = false;
    const finish = (closed) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    timer.unref?.();
    child.once("close", onClose);
  });
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  stopCapturing(child);
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true
    });
    if (await waitForClose(child, 2_000)) return;
    try { child.kill("SIGKILL"); } catch { /* Continue to verified close below. */ }
    if (await waitForClose(child, 2_000)) return;
    throw new Error(`Could not terminate managed Windows process ${child.pid}.`);
  }
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {
      try { child.kill("SIGTERM"); } catch { /* Already exited. */ }
    }
  }
  if (await waitForClose(child, 750)) return;
  if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
    }
  }
  if (!await waitForClose(child, 2_000)) throw new Error(`Could not terminate managed process group ${child.pid}.`);
}

function callMcp(provider, calls, environment, cwd) {
  return new Promise((resolve, reject) => {
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract-test", version: "1" } } },
      ...calls.map((call, index) => ({
        jsonrpc: "2.0",
        id: index + 2,
        method: "tools/call",
        params: { name: call.name, arguments: { rawArguments: call.rawArguments } }
      }))
    ];
    const expectedIds = new Set(messages.map(({ id }) => id));
    const runtime = path.join(ROOT, "plugins", provider, "scripts", "companion.mjs");
    const child = spawn(process.execPath, [runtime, "mcp"], {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let inputEnded = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const abort = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await terminate(child);
        reject(error);
      } catch (terminationError) {
        reject(new Error(`${error.message} ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`));
      }
    };
    const timer = setTimeout(() => void abort(new Error(`${provider} contract MCP did not exit within 20 seconds.`)), 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
        void abort(new Error(`${provider} contract stdout exceeded 4 MiB.`));
      }
      if (!inputEnded) {
        const receivedIds = new Set();
        for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
          try {
            const message = JSON.parse(line);
            if (expectedIds.has(message.id)) receivedIds.add(message.id);
          } catch { /* The final line may still be incomplete. */ }
        }
        if (receivedIds.size === expectedIds.size) {
          inputEnded = true;
          child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 2 * 1024 * 1024) {
        void abort(new Error(`${provider} contract stderr exceeded 2 MiB.`));
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.stdin.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) return reject(new Error(stderr || `${provider} MCP exited ${code}.`));
        try {
          const transcript = `${stdout}\n${stderr}`;
          assert.doesNotMatch(transcript, new RegExp(CANARY));
          resolve(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
        } catch (error) {
          reject(error);
        }
      });
    });
    child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  });
}

function leafStrings(value, collected = []) {
  if (typeof value === "string") collected.push(value);
  else if (Array.isArray(value)) for (const item of value) leafStrings(item, collected);
  else if (value && typeof value === "object") for (const item of Object.values(value)) leafStrings(item, collected);
  return collected;
}

function initializedProject(temporary) {
  const project = path.join(temporary, "project");
  fs.mkdirSync(project, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", project], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(initialized.error, undefined, initialized.error?.message);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  return project;
}

function workingProviderEnvironment(provider, temporary, project, overrides = {}) {
  const state = path.join(temporary, "state");
  const home = path.join(temporary, "home");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const environment = minimalEnvironment({
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PLUGIN_DATA: state,
    MODEL_COMPANION_STATE_DIR: state,
    MODEL_COMPANION_PROJECT_DIR: project,
    KIMI_API_KEY: CANARY,
    ANTHROPIC_API_KEY: CANARY,
    OPENAI_API_KEY: CANARY
  });
  const fakeConfiguration = Object.fromEntries(Object.entries(overrides).filter(([name]) => name.startsWith("FAKE_")));
  const fakeConfigurationFile = path.join(temporary, `fake-kimi-${process.pid}-${kimiFixtureConfigCounter++}.json`);
  fs.writeFileSync(fakeConfigurationFile, JSON.stringify(fakeConfiguration), { mode: 0o600 });
  // Keep the test launcher inside the same trust boundary enforced in
  // production. In particular, do not hide an untrusted matrix runtime behind
  // the fixture's `#!/usr/bin/env node` shebang and a rewritten PATH.
  environment.KIMI_BIN = trustedNodeLauncher(environment);
  environment.KIMI_BIN_ARGS_JSON = JSON.stringify([FIXTURES.kimi, "--fake-config", fakeConfigurationFile]);
  for (const [name, value] of Object.entries(overrides)) {
    if (provider === "kimi" && name.startsWith("FAKE_")) continue;
    environment[name] = value;
  }
  return environment;
}

function mcpToolResult(messages, id = 2) {
  const result = messages.find((message) => message.id === id)?.result;
  assert.ok(result, `MCP response ${id} is missing`);
  return result;
}

function assertStructuredResult(result, provider, command) {
  assert.equal(result.isError, false);
  assertEnvelope(result.structuredContent, provider, command);
  assert.deepEqual(JSON.parse(result.content?.[0]?.text), result.structuredContent);
  return result.structuredContent.data;
}

function findJobId(text, provider) {
  const match = String(text || "").match(new RegExp(`\\b${provider}-[a-z0-9]+-[a-f0-9]{8}\\b`));
  assert.ok(match, `Could not find a ${provider} job ID in the start response.`);
  return match[0];
}

function collectProcessIds(value, ids = new Set()) {
  if (!value || typeof value !== "object") return ids;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:pid|workerPid|guardPid|providerPid|grandchildPid)$/.test(key) && Number.isSafeInteger(item) && item > 1 && item !== process.pid) ids.add(item);
    else if (item && typeof item === "object") collectProcessIds(item, ids);
  }
  return ids;
}

function forceTerminateStateProcesses(state) {
  if (!fs.existsSync(state)) return;
  const ids = new Set();
  for (const file of filesBelow(state).filter((name) => name.endsWith(".json") || name.endsWith(".lock"))) {
    try { collectProcessIds(JSON.parse(fs.readFileSync(file, "utf8")), ids); } catch { /* Ignore partial test state. */ }
  }
  for (const id of ids) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(id), "/T", "/F"], { stdio: "ignore", timeout: 5_000, windowsHide: true });
    } else {
      try { process.kill(-id, "SIGKILL"); } catch {
        try { process.kill(id, "SIGKILL"); } catch { /* Already stopped. */ }
      }
    }
  }
}

function filesBelow(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(target));
    else files.push(target);
  }
  return files;
}

function assertEnvelope(value, provider, command) {
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.provider, provider);
  assert.equal(value.command, command);
  assert.equal(Number.isFinite(Date.parse(value.generatedAt)), true);
  assert.match(value.generatedAt, /Z$/);
  assert.equal(Object.hasOwn(value, "data"), true);
  assert.equal(Object.hasOwn(value, "error"), false);
  assert.equal(typeof value.data, "object");
  assert.notEqual(value.data, null);
}

function assertErrorEnvelope(value, provider, command) {
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.provider, provider);
  assert.equal(value.command, command);
  assert.equal(Number.isFinite(Date.parse(value.generatedAt)), true);
  assert.match(value.generatedAt, /Z$/);
  assert.equal(Object.hasOwn(value, "data"), false);
  assert.equal(Object.hasOwn(value, "error"), true);
  assert.equal(typeof value.error.code, "string");
  assert.ok(value.error.code.length > 0);
  assert.equal(typeof value.error.message, "string");
  assert.equal(typeof value.error.retryable, "boolean");
  assert.ok(value.error.hint === null || typeof value.error.hint === "string");
  assert.ok(value.error.exitCode === undefined
    || (Number.isSafeInteger(value.error.exitCode) && value.error.exitCode >= 1 && value.error.exitCode <= 255));
}

for (const provider of ["kimi"]) {
  test(`${provider} exposes the common structured-output envelope`, async (context) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-contract-`));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const stateDirectory = path.join(temporary, "state");
    const projectDirectory = path.join(temporary, "project");
    const homeDirectory = path.join(temporary, "home");
    fs.mkdirSync(stateDirectory);
    fs.mkdirSync(projectDirectory);
    fs.mkdirSync(homeDirectory);
    const initialized = spawnSync("git", ["init", "--quiet", projectDirectory], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(initialized.error, undefined, initialized.error?.message);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const missingProvider = path.join(temporary, process.platform === "win32" ? "missing-provider.exe" : "missing-provider");
    const environment = minimalEnvironment({
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
      CLAUDE_PLUGIN_DATA: stateDirectory,
      MODEL_COMPANION_PROJECT_DIR: projectDirectory,
      KIMI_BIN: missingProvider,
      CLAUDE_BIN: missingProvider,
      ZAI_API_KEY: CANARY,
      KIMI_API_KEY: CANARY,
      ANTHROPIC_API_KEY: CANARY
    });
    const missingJobId = `${provider}-test-00000000`;
    const messages = await callMcp(provider, [
      { name: "models", rawArguments: "--json" },
      { name: "config", rawArguments: "--json" },
      { name: "usage", rawArguments: "--local --json --window all --scope repo" },
      { name: "cleanup", rawArguments: "--older-than 1d --dry-run --json" },
      { name: "status", rawArguments: `${missingJobId} --json` },
      { name: "result", rawArguments: `${missingJobId} --json` },
      { name: "cancel", rawArguments: `${missingJobId} --json` },
      { name: "setup", rawArguments: "--json" }
    ], environment, projectDirectory);
    for (const [index, command] of ["models", "config", "usage", "cleanup"].entries()) {
      const result = messages.find((message) => message.id === index + 2)?.result;
      assert.equal(result?.isError, false);
      assertEnvelope(result.structuredContent, provider, command);
      const rendered = JSON.parse(result.content?.[0]?.text);
      assert.deepEqual(rendered, result.structuredContent);
    }
    const setupError = mcpToolResult(messages, 9);
    assert.equal(setupError.isError, true);
    assertErrorEnvelope(setupError.structuredContent, provider, "setup");
    assert.deepEqual(JSON.parse(setupError.content?.[0]?.text), setupError.structuredContent);
    for (const [offset, command] of ["status", "result", "cancel"].entries()) {
      const result = messages.find((message) => message.id === offset + 6)?.result;
      assert.equal(result?.isError, true);
      assertErrorEnvelope(result.structuredContent, provider, command);
      assert.equal(result.structuredContent.error.code, "JOB_NOT_FOUND");
      const rendered = JSON.parse(result.content?.[0]?.text);
      assert.deepEqual(rendered, result.structuredContent);
    }
    const strings = leafStrings(messages);
    for (const privateValue of [temporary, stateDirectory, projectDirectory, homeDirectory, CANARY]) {
      const normalizedPrivateValue = privateValue.replaceAll("\\", "/");
      assert.equal(strings.some((value) => value.includes(privateValue) || value.replaceAll("\\", "/").includes(normalizedPrivateValue)), false, `structured output leaked ${privateValue}`);
    }
  });
}

for (const provider of ["kimi"]) {
  test(`${provider} setup succeeds without a billable model request`, async (context) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-setup-contract-`));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const project = initializedProject(temporary);
    const environment = workingProviderEnvironment(provider, temporary, project);
    const messages = await callMcp(provider, [{ name: "setup", rawArguments: "--json" }], environment, project);
    const data = assertStructuredResult(mcpToolResult(messages), provider, "setup");
    assert.equal(data.billableModelRequestMade, false);
    assert.equal(data.authenticationVerified, false);
  });

  test(`${provider} managed jobs expose successful status, result, and cancel envelopes`, async (context) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-lifecycle-contract-`));
    const state = path.join(temporary, "state");
    context.after(() => {
      forceTerminateStateProcesses(state);
      fs.rmSync(temporary, { recursive: true, force: true });
    });
    const project = initializedProject(temporary);
    const environment = workingProviderEnvironment(provider, temporary, project);

    const started = await callMcp(provider, [{
      name: "run_task",
      rawArguments: "--background --label contract-finished Complete the conformance task"
    }], environment, project);
    const finishedJobId = findJobId(mcpToolResult(started).content?.[0]?.text, provider);

    const resultMessages = await callMcp(provider, [{
      name: "result",
      rawArguments: `${finishedJobId} --wait --timeout 15s --json`
    }], environment, project);
    const resultData = assertStructuredResult(mcpToolResult(resultMessages), provider, "result");
    assert.equal(resultData.job.id, finishedJobId);
    assert.equal(resultData.job.status, "finished");

    const statusMessages = await callMcp(provider, [{ name: "status", rawArguments: `${finishedJobId} --json` }], environment, project);
    const statusData = assertStructuredResult(mcpToolResult(statusMessages), provider, "status");
    assert.equal(statusData.jobs.length, 1);
    assert.equal(statusData.jobs[0].id, finishedJobId);
    assert.equal(statusData.jobs[0].status, "finished");

    const failingEnvironment = workingProviderEnvironment(provider, temporary, project, { FAKE_PROVIDER_MODE: "fail" });
    const failing = await callMcp(provider, [{
      name: "run_task",
      rawArguments: "--background --label contract-failed Fail this conformance task"
    }], failingEnvironment, project);
    const failedJobId = findJobId(mcpToolResult(failing).content?.[0]?.text, provider);
    const failedResultMessages = await callMcp(provider, [{
      name: "result",
      rawArguments: `${failedJobId} --wait --timeout 15s --json`
    }], failingEnvironment, project);
    const failedResultData = assertStructuredResult(mcpToolResult(failedResultMessages), provider, "result");
    assert.equal(failedResultData.job.id, failedJobId);
    assert.equal(failedResultData.job.status, "failed");

    const waitingEnvironment = workingProviderEnvironment(provider, temporary, project, {
      FAKE_PROVIDER_MODE: "wait",
      FAKE_RECORD_FILE: path.join(state, "contract-wait-processes.json")
    });
    const waiting = await callMcp(provider, [{
      name: "run_task",
      rawArguments: "--background --label contract-cancel Cancel this conformance task"
    }], waitingEnvironment, project);
    const waitingJobId = findJobId(mcpToolResult(waiting).content?.[0]?.text, provider);
    const cancelMessages = await callMcp(provider, [{ name: "cancel", rawArguments: `${waitingJobId} --json` }], waitingEnvironment, project);
    const cancelData = assertStructuredResult(mcpToolResult(cancelMessages), provider, "cancel");
    assert.equal(cancelData.cancelled, true);
    assert.equal(cancelData.job.id, waitingJobId);
    assert.equal(cancelData.job.status, "cancelled");
  });
}

test("Kimi experimental sessions expose a bounded v2 lifecycle contract", async (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-session-contract-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const project = initializedProject(temporary);
  const environment = workingProviderEnvironment("kimi", temporary, project, { FAKE_ACP_OUTPUT: "bounded session response" });

  const listed = await callMcp("kimi", [{ name: "session", rawArguments: "--experimental list --json" }], environment, project);
  const listData = assertStructuredResult(mcpToolResult(listed), "kimi", "session");
  assert.equal(listData.action, "list");
  assert.ok(Array.isArray(listData.sessions));

  const started = await callMcp("kimi", [{ name: "session", rawArguments: "--experimental start --json Explain the contract" }], environment, project);
  const startData = assertStructuredResult(mcpToolResult(started), "kimi", "session");
  assert.equal(startData.action, "start");
  assert.equal(startData.output, "bounded session response");
  assert.equal(JSON.stringify(startData).includes("Explain the contract"), false, "session structured output must not duplicate the prompt");
});
