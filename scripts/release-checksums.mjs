#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertExactPackageFiles } from "./package-policy.mjs";
import { isolatedNpmEnvironment, resolveNpmInvocation } from "./npm-launcher.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(args) {
  const parsed = { output: path.join(ROOT, "dist") };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output" && args[index + 1]) parsed.output = path.resolve(args[++index]);
    else throw new Error("Usage: node scripts/release-checksums.mjs [--output <directory>]");
  }
  return parsed;
}

function pack(provider, temporary) {
  const npm = resolveNpmInvocation();
  const result = spawnSync(npm.command, [...npm.argsPrefix, "pack", path.join(ROOT, "plugins", provider), "--ignore-scripts", "--json", "--pack-destination", temporary], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: isolatedNpmEnvironment(temporary)
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `npm pack failed for ${provider}.`);
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report) || report.length !== 1 || !report[0]?.filename) throw new Error(`Unexpected npm pack response for ${provider}.`);
  if (path.basename(report[0].filename) !== report[0].filename) throw new Error(`npm pack returned an unsafe archive name for ${provider}.`);
  assertExactPackageFiles(provider, report[0].files);
  const unpackedBytes = report[0].files.reduce((total, entry) => {
    if (!Number.isSafeInteger(entry?.size) || entry.size < 0) throw new Error(`${provider} npm pack reported an invalid file size.`);
    return total + entry.size;
  }, 0);
  if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes <= 0 || unpackedBytes > 64 * 1024 * 1024) {
    throw new Error(`${provider} packed contents violated the 64 MiB unpacked release safety limit.`);
  }
  const archive = path.join(temporary, report[0].filename);
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 32 * 1024 * 1024) {
    throw new Error(`${provider} packed archive violated the 32 MiB release safety limit.`);
  }
  return archive;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeAll(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("Release artifact write made no progress.");
    offset += written;
  }
}

function publishBuffer(destination, buffer, created) {
  let descriptor;
  let failure;
  try {
    descriptor = fs.openSync(destination, "wx", 0o600);
    created.push(destination);
    if (process.env.NODE_ENV === "test" && process.env.MODEL_COMPANION_TEST_RELEASE_FAIL_AFTER_CREATE === "1") {
      throw new Error("Injected release publication failure.");
    }
    writeAll(descriptor, buffer);
    fs.fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try { fs.closeSync(descriptor); } catch (error) { if (!failure) failure = error; }
  }
  if (failure) throw failure;
}

function publishFile(source, destination, created) {
  let sourceDescriptor;
  let destinationDescriptor;
  let failure;
  try {
    sourceDescriptor = fs.openSync(source, "r");
    destinationDescriptor = fs.openSync(destination, "wx", 0o600);
    created.push(destination);
    if (process.env.NODE_ENV === "test" && process.env.MODEL_COMPANION_TEST_RELEASE_FAIL_AFTER_CREATE === "1") {
      throw new Error("Injected release publication failure.");
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      writeAll(destinationDescriptor, buffer.subarray(0, read));
    }
    fs.fsyncSync(destinationDescriptor);
  } catch (error) {
    failure = error;
  }
  for (const descriptor of [sourceDescriptor, destinationDescriptor]) {
    if (descriptor === undefined) continue;
    try { fs.closeSync(descriptor); } catch (error) { if (!failure) failure = error; }
  }
  if (failure) throw failure;
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-release-"));
try {
  const options = parseArguments(process.argv.slice(2));
  fs.mkdirSync(options.output, { recursive: true });
  const packed = [pack("kimi", temporary)];
  const destinations = packed.map((archive) => path.join(options.output, path.basename(archive)));
  const sums = path.join(options.output, "SHA256SUMS");
  for (const destination of [...destinations, sums]) {
    if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite existing release artifact: ${destination}`);
  }
  const lines = [];
  for (const [index, archive] of packed.entries()) {
    lines.push(`${sha256(archive)}  ${path.basename(destinations[index])}`);
  }
  const created = [];
  try {
    for (const [index, archive] of packed.entries()) {
      publishFile(archive, destinations[index], created);
    }
    publishBuffer(sums, Buffer.from(`${lines.join("\n")}\n`, "utf8"), created);
  } catch (error) {
    for (const file of created.reverse()) {
      try { fs.unlinkSync(file); } catch { /* Only remove files created by this invocation. */ }
    }
    throw error;
  }
  process.stdout.write(`Created ${lines.length} release archives and ${sums}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
