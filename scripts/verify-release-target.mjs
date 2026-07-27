#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function usage() {
  return "Usage: node scripts/verify-release-target.mjs [v<version>]";
}

const [tag = "", ...extra] = process.argv.slice(2);
try {
  if (extra.length) throw new Error(usage());
  if (!tag) {
    process.stdout.write("Verified manual Kimi release target.\n");
  } else {
    const match = /^v(.+)$/.exec(tag);
    if (!match || !VERSION_PATTERN.test(match[1])) throw new Error(`Release tag must match v<semver>: ${tag}`);
    const manifestFile = path.join(ROOT, "plugins", "kimi", ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.version !== match[1]) {
      throw new Error(`${tag} does not match ${path.relative(ROOT, manifestFile)} version ${manifest.version}.`);
    }
    process.stdout.write(`Verified tagged release target: kimi@${match[1]}.\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
