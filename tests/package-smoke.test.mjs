import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertExactPackageFiles, expectedPackageDirectories, expectedPackageFiles } from "../scripts/package-policy.mjs";
import { isolatedNpmEnvironment, resolveNpmInvocation } from "../scripts/npm-launcher.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_TOOLS = {
  kimi: ["cancel", "cleanup", "config", "explore", "models", "plan", "result", "review", "run_task", "session", "setup", "status", "usage"]
};

function minimalEnvironment(overrides = {}) {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "SHELL", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
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
    throw new Error(`Could not terminate packed MCP Windows process ${child.pid}.`);
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
  if (!await waitForClose(child, 2_000)) throw new Error(`Could not terminate packed MCP process group ${child.pid}.`);
}

function safeArchiveRelative(filename, directory, expectedFiles, expectedDirectories) {
  if (!filename.startsWith("package/")) return undefined;
  const relative = filename.slice("package/".length).replace(/\/$/, "");
  if (!relative) return directory ? "" : undefined;
  if (relative.includes("\\") || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative) return undefined;
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  if (directory ? !expectedDirectories.has(relative) : !expectedFiles.has(relative)) return undefined;
  return relative;
}

function tarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer.subarray(start, end === -1 || end > start + length ? start + length : end).toString("utf8");
}

function extractSafeNpmArchive(archive, destination, provider) {
  const compressed = fs.readFileSync(archive);
  assert.ok(compressed.length <= 32 * 1024 * 1024, "packed archive exceeds 32 MiB");
  const tarball = zlib.gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const expectedFiles = new Set(expectedPackageFiles(provider));
  const expectedDirectories = expectedPackageDirectories(provider);
  const extractedFiles = [];
  let offset = 0;
  while (offset + 512 <= tarball.length) {
    const header = tarball.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const filename = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).trim().replace(/\0.*$/, "");
    assert.match(sizeText, /^[0-7]+$/, `invalid tar size for ${filename}`);
    const size = Number.parseInt(sizeText, 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 64 * 1024 * 1024, `unsafe tar size for ${filename}`);
    const type = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert.ok(dataEnd <= tarball.length, `truncated tar entry: ${filename}`);
    if (type === "x" || type === "g") {
      // npm may include PAX metadata. Package paths are short and are still
      // validated from the following concrete entry.
    } else {
      const relative = safeArchiveRelative(filename, type === "5", expectedFiles, expectedDirectories);
      assert.notEqual(relative, undefined, `unsafe archive entry: ${filename}`);
      const target = relative ? path.join(destination, "package", ...relative.split("/")) : path.join(destination, "package");
      if (type === "5") fs.mkdirSync(target, { recursive: true });
      else if (type === "0" || type === "\0") {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, tarball.subarray(dataStart, dataEnd), { flag: "wx" });
        extractedFiles.push(relative);
      } else {
        assert.fail(`unsupported archive entry type ${JSON.stringify(type)}: ${filename}`);
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  assertExactPackageFiles(provider, extractedFiles);
}

function pack(provider, destination) {
  const npm = resolveNpmInvocation();
  const result = spawnSync(npm.command, [...npm.argsPrefix, "pack", path.join(ROOT, "plugins", provider), "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: isolatedNpmEnvironment(destination)
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  assert.ok(report[0].files.length > 0);
  assertExactPackageFiles(provider, report[0].files);
  assert.equal(path.basename(report[0].filename), report[0].filename, "npm pack returned an unsafe archive name");
  return path.join(destination, report[0].filename);
}

function callToolsList(runtime, cwd, environment) {
  return new Promise((resolve, reject) => {
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
    const timer = setTimeout(() => void abort(new Error("Packed MCP server did not exit within 15 seconds.")), 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        void abort(new Error("Packed MCP stdout exceeded 2 MiB."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 2 * 1024 * 1024) {
        void abort(new Error("Packed MCP stderr exceeded 2 MiB."));
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.stdin.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0) return reject(new Error(stderr || `MCP smoke process exited ${code}.`));
        try {
          const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
          resolve({
            serverInfo: messages.find((message) => message.id === 1)?.result?.serverInfo,
            tools: messages.find((message) => message.id === 2)?.result?.tools || []
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    child.stdin.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-smoke", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      ""
    ].join("\n"));
  });
}

for (const provider of ["kimi"]) {
  test(`${provider} packed artifact is self-contained and starts its MCP server`, async (context) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-pack-smoke-`));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const archive = pack(provider, temporary);
    const extract = path.join(temporary, "extract");
    const project = path.join(temporary, "project");
    const state = path.join(temporary, "state");
    const testHome = path.join(temporary, "home");
    fs.mkdirSync(extract);
    fs.mkdirSync(project);
    fs.mkdirSync(state);
    fs.mkdirSync(testHome);
    const initialized = spawnSync("git", ["init", "--quiet", project], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(initialized.error, undefined, initialized.error?.message);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    extractSafeNpmArchive(archive, extract, provider);
    const packageRoot = path.join(extract, "package");
    const runtime = path.join(packageRoot, "scripts", "companion.mjs");
    assert.equal(fs.existsSync(runtime), true);
    const source = fs.readFileSync(runtime, "utf8");
    assert.doesNotMatch(source, /from\s+["']\.\.\//);
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, provider);
    assert.equal(manifest.version, packageJson.version);
    const { serverInfo, tools } = await callToolsList(runtime, packageRoot, minimalEnvironment({
      HOME: testHome,
      USERPROFILE: testHome,
      CLAUDE_PLUGIN_DATA: state,
      MODEL_COMPANION_PROJECT_DIR: project
    }));
    assert.deepEqual(serverInfo, { name: `${provider}-companion`, version: packageJson.version });
    assert.deepEqual(tools.map(({ name }) => name).sort(), EXPECTED_TOOLS[provider]);
  });
}
