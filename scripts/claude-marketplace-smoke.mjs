#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDERS = ["kimi"];
const MARKETPLACE = "model-companions-kimi";
const PASSTHROUGH = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "SHELL",
  "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "VOLTA_HOME"
];

function resolveClaude() {
  if (process.platform === "win32") {
    throw new Error("The Claude marketplace smoke test runs in the Ubuntu validator lane; Windows command shims are not executed.");
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.resolve(directory || ".", "claude");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch { /* Continue through PATH. */ }
  }
  throw new Error("Claude Code is not available on PATH.");
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function nextPatch(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Marketplace smoke requires a stable semantic plugin version; received ${version}.`);
  const patch = BigInt(match[3]) + 1n;
  return `${match[1]}.${match[2]}.${patch}`;
}

function bumpFixtureProvider(fixture, provider) {
  const packageRoot = path.join(fixture, "plugins", provider);
  const manifestFile = path.join(packageRoot, ".claude-plugin", "plugin.json");
  const packageFile = path.join(packageRoot, "package.json");
  const runtimeFile = path.join(packageRoot, "scripts", "companion.mjs");
  const manifest = readJson(manifestFile);
  const packageJson = readJson(packageFile);
  const runtime = fs.readFileSync(runtimeFile, "utf8");
  const runtimeVersion = runtime.match(/^const VERSION = "([^"]+)";$/m)?.[1];
  assert.equal(packageJson.version, manifest.version, `${provider} fixture package and plugin versions differ before upgrade`);
  assert.equal(runtimeVersion, manifest.version, `${provider} fixture runtime and plugin versions differ before upgrade`);

  const version = nextPatch(manifest.version);
  manifest.version = version;
  packageJson.version = version;
  const updatedRuntime = runtime.replace(/^const VERSION = "[^"]+";$/m, `const VERSION = ${JSON.stringify(version)};`);
  assert.notEqual(updatedRuntime, runtime, `${provider} fixture runtime version was not updated`);
  writeJson(manifestFile, manifest);
  writeJson(packageFile, packageJson);
  fs.writeFileSync(runtimeFile, updatedRuntime, "utf8");
  return version;
}

function advanceMarketplaceVersion(fixture) {
  const marketplaceFile = path.join(fixture, ".claude-plugin", "marketplace.json");
  const marketplace = readJson(marketplaceFile);
  assert.equal(marketplace.plugins.some((entry) => Object.hasOwn(entry, "version")), false);
  marketplace.version = nextPatch(marketplace.version);
  writeJson(marketplaceFile, marketplace);
}

function runClaude(claude, args, cwd, environment) {
  const result = spawnSync(claude, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `claude ${args.join(" ")} failed.`);
  return result.stdout;
}

function installedPlugin(plugins, provider) {
  const matches = plugins.filter(({ id }) => id === `${provider}@${MARKETPLACE}`);
  assert.equal(matches.length, 1, `Expected one installed ${provider} plugin, received ${matches.length}.`);
  return matches[0];
}

function assertInstalledRuntime(plugin, provider, version, cwd, environment) {
  assert.equal(plugin.version, version);
  assert.match(plugin.installPath || "", new RegExp(`${provider}[/\\\\]${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  assert.equal(path.isAbsolute(plugin.installPath || ""), true, `${provider} install path must be absolute.`);
  const runtime = path.join(plugin.installPath, "scripts", "companion.mjs");
  assert.equal(fs.statSync(runtime).isFile(), true, `${provider} installed runtime is missing.`);
  const result = spawnSync(process.execPath, [runtime, "mcp"], {
    cwd,
    env: environment,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "marketplace-smoke", version: "1" } } })}\n`,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const messages = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(messages.find(({ id }) => id === 1)?.result?.serverInfo, {
    name: `${provider}-companion`,
    version
  });
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-kimi-claude-smoke-"));
try {
  const claude = resolveClaude();
  const fixture = path.join(temporary, "marketplace");
  const config = path.join(temporary, "claude-config");
  const home = path.join(temporary, "home");
  fs.mkdirSync(path.join(fixture, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "plugins"), { recursive: true });
  fs.mkdirSync(config);
  fs.mkdirSync(home);
  fs.copyFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), path.join(fixture, ".claude-plugin", "marketplace.json"));
  for (const provider of PROVIDERS) {
    fs.cpSync(path.join(ROOT, "plugins", provider), path.join(fixture, "plugins", provider), { recursive: true });
  }
  const environment = {};
  for (const key of PASSTHROUGH) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    NO_COLOR: "1"
  });

  runClaude(claude, ["plugin", "marketplace", "add", "./marketplace"], temporary, environment);
  const marketplaces = JSON.parse(runClaude(claude, ["plugin", "marketplace", "list", "--json"], temporary, environment));
  assert.deepEqual(marketplaces.map(({ name }) => name), [MARKETPLACE]);
  for (const provider of PROVIDERS) {
    runClaude(claude, ["plugin", "install", `${provider}@${MARKETPLACE}`, "--scope", "user"], temporary, environment);
  }
  const initial = JSON.parse(runClaude(claude, ["plugin", "list", "--json"], temporary, environment));
  const expectedVersions = new Map();
  for (const provider of PROVIDERS) {
    const expected = readJson(path.join(fixture, "plugins", provider, ".claude-plugin", "plugin.json")).version;
    expectedVersions.set(provider, expected);
    assertInstalledRuntime(installedPlugin(initial, provider), provider, expected, temporary, environment);
  }

  const transitions = [];
  for (const provider of PROVIDERS) {
    const previous = expectedVersions.get(provider);
    const upgraded = bumpFixtureProvider(fixture, provider);
    expectedVersions.set(provider, upgraded);
    advanceMarketplaceVersion(fixture);
    runClaude(claude, ["plugin", "marketplace", "update", MARKETPLACE], temporary, environment);
    runClaude(claude, ["plugin", "update", `${provider}@${MARKETPLACE}`], temporary, environment);
    const installed = JSON.parse(runClaude(claude, ["plugin", "list", "--json"], temporary, environment));
    for (const candidate of PROVIDERS) {
      assertInstalledRuntime(installedPlugin(installed, candidate), candidate, expectedVersions.get(candidate), temporary, environment);
    }
    transitions.push(`${provider} ${previous} -> ${upgraded}`);
  }
  process.stdout.write(`Claude marketplace smoke passed: ${transitions.join("; ")}; the installed MCP runtime initialized after upgrade.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
