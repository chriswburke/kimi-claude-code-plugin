import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const runtime = path.join(pluginRoot, "scripts", "companion.mjs");
export const fixture = path.join(pluginRoot, "tests", "fixtures", "fake-kimi.mjs");
let fakeConfigCounter = 0;
let providerFixture;

export function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kimi-companion-test-"));
}

// Mirrors assertTrustedPosixExecutable in the runtime: every ancestor must be
// owned by this user or root and must not be group- or world-writable.
function trustedExecutableChain(target) {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  const uid = process.getuid();
  let directory;
  try { directory = path.dirname(fs.realpathSync(target)); } catch { return false; }
  while (true) {
    let stat;
    try { stat = fs.statSync(directory); } catch { return false; }
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0) return false;
    const parent = path.dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

// A CI checkout can sit below a group- or world-writable ancestor, which the
// runtime executable-trust check correctly rejects. Stage the fixture where the
// chain is trusted rather than relaxing that check, which is a real security
// boundary. Local checkouts already qualify, so nothing is copied there.
function trustedProviderFixture() {
  if (providerFixture !== undefined) return providerFixture;
  if (trustedExecutableChain(fixture)) return (providerFixture = fixture);
  for (const base of [os.homedir(), os.tmpdir()]) {
    try {
      const directory = fs.mkdtempSync(path.join(base, ".kimi-test-bin-"));
      fs.chmodSync(directory, 0o700);
      const staged = path.join(directory, "fake-kimi.mjs");
      fs.copyFileSync(fixture, staged);
      fs.chmodSync(staged, 0o700);
      if (trustedExecutableChain(staged)) return (providerFixture = staged);
    } catch { /* Try the next candidate base. */ }
  }
  return (providerFixture = fixture);
}

export function fakeEnvironment(temporary, overrides = {}) {
  const fakeConfiguration = Object.fromEntries(Object.entries(overrides).filter(([key]) => key.startsWith("FAKE_")));
  const fakeConfigFile = path.join(temporary, `fake-kimi-${process.pid}-${fakeConfigCounter++}.json`);
  fs.writeFileSync(fakeConfigFile, JSON.stringify(fakeConfiguration), { mode: 0o600 });
  // On POSIX, invoke the executable fixture directly. A matrix test runner may
  // itself live below a deliberately untrusted directory such as /tmp; using
  // process.execPath as KIMI_BIN would then correctly trip the production
  // executable-chain check before the fixture can run. Windows requires a
  // native executable, so retain the Node launcher there.
  const usesExternalLauncher = process.platform === "win32" || Object.hasOwn(overrides, "KIMI_BIN");
  const fakeProvider = usesExternalLauncher
    ? { KIMI_BIN: process.execPath, KIMI_BIN_ARGS_JSON: JSON.stringify([fixture, "--fake-config", fakeConfigFile]) }
    : { KIMI_BIN: trustedProviderFixture(), KIMI_BIN_ARGS_JSON: JSON.stringify(["--fake-config", fakeConfigFile]) };
  const environment = {
    ...process.env,
    MODEL_COMPANION_STATE_DIR: path.join(temporary, "state"),
    ...fakeProvider,
    ...overrides
  };
  // Tests run from inside Claude Code inherit a real CLAUDE_PLUGIN_DATA. It
  // outranks MODEL_COMPANION_STATE_DIR in dataRoot(), so leaving it set points
  // the suite at the user's live plugin state instead of the temporary one.
  if (!Object.hasOwn(overrides, "CLAUDE_PLUGIN_DATA")) delete environment.CLAUDE_PLUGIN_DATA;
  for (const key of Object.keys(environment)) {
    if (key.startsWith("FAKE_")) delete environment[key];
  }
  return environment;
}

export function run(args, options = {}) {
  return spawnSync(process.execPath, [runtime, ...args], {
    cwd: options.cwd || pluginRoot,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 20_000
  });
}

export function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

export function createChangedRepository() {
  const directory = temporaryDirectory();
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(directory, "example.js"), "export const value = 1;\n");
  git(directory, ["add", "example.js"]);
  git(directory, ["commit", "--no-gpg-sign", "-qm", "initial"]);
  fs.writeFileSync(path.join(directory, "example.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(directory, "untracked.txt"), "untracked review content\n");
  return directory;
}

export function parseJsonLines(output) {
  return output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function mcpExchange({ messages, responseId, env, cwd = pluginRoot, closeImmediately = false, timeout = 15_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtime, "mcp"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let ended = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for MCP response ${responseId}: ${stderr}`));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const hasResponse = stdout.split("\n").slice(0, -1).some((line) => {
        try { return JSON.parse(line).id === responseId; } catch { return false; }
      });
      if (!ended && hasResponse) {
        ended = true;
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.write(`${messages.map(JSON.stringify).join("\n")}\n`);
    if (closeImmediately) {
      ended = true;
      child.stdin.end();
    }
  });
}

export function findFile(directory, suffix) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(target, suffix);
      if (nested) return nested;
    } else if (target.endsWith(suffix)) return target;
  }
  return undefined;
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function poll(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}
