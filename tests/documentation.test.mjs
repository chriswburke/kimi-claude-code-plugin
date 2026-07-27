import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_ROOT = fs.realpathSync(ROOT);
const DOCS_ROOT = path.join(ROOT, "docs");
const CONTENT_TYPES = new Set(["Tutorial", "How-to", "Reference", "Conceptual", "Troubleshooting", "Landing"]);
const DOC_FILES = fs.readdirSync(DOCS_ROOT)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => path.join(DOCS_ROOT, name));
const PACKAGE_READMES = [path.join(ROOT, "plugins", "kimi", "README.md")];
const POLICY_FILES = [
  path.join(ROOT, "SECURITY.md"),
  path.join(ROOT, "CONTRIBUTING.md"),
  path.join(ROOT, ".github", "pull_request_template.md")
];
const LINK_FILES = [path.join(ROOT, "README.md"), ...POLICY_FILES, ...PACKAGE_READMES, ...DOC_FILES];
const PROSE_FILES = [path.join(ROOT, "README.md"), ...POLICY_FILES, ...PACKAGE_READMES, ...DOC_FILES];

function normalizeMarkdown(source) {
  return source.replace(/\r\n?/g, "\n");
}

function readMarkdown(filename) {
  return normalizeMarkdown(fs.readFileSync(filename, "utf8"));
}

function markdownFence(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  return match ? { marker: match[1], info: match[2] } : undefined;
}

function sourceWithoutFencedCode(source) {
  const lines = normalizeMarkdown(source).replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  let marker;
  return lines.map((line) => {
    const fence = markdownFence(line);
    if (!marker && fence) {
      marker = fence.marker;
      return "";
    }
    if (marker) {
      if (fence
        && fence.marker[0] === marker[0]
        && fence.marker.length >= marker.length
        && fence.info.trim() === "") marker = undefined;
      return "";
    }
    return line;
  }).join("\n");
}

function stripInlineCode(line) {
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      result += line[index++];
      continue;
    }
    let length = 1;
    while (line[index + length] === "`") length += 1;
    const delimiter = "`".repeat(length);
    const closing = line.indexOf(delimiter, index + length);
    if (closing === -1) {
      result += delimiter;
      index += length;
    } else {
      result += " ";
      index = closing + length;
    }
  }
  return result;
}

function proseWithoutCode(source) {
  return sourceWithoutFencedCode(source).split("\n").map(stripInlineCode).join("\n");
}

function headingAnchors(source) {
  const anchors = new Set();
  for (const match of sourceWithoutFencedCode(source).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1]
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    anchors.add(heading);
  }
  return anchors;
}

function resolveMarkdownTarget(sourceFile, rawTarget) {
  const [rawPath, anchor = ""] = rawTarget.split("#", 2);
  const filename = rawPath
    ? path.resolve(path.dirname(sourceFile), decodeURIComponent(rawPath))
    : sourceFile;
  return { filename, anchor };
}

function assertRepositoryPath(sourceFile, filename, rawTarget) {
  const realTarget = fs.realpathSync(filename);
  const relative = path.relative(REAL_ROOT, realTarget);
  const inside = relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.equal(inside, true, `${path.relative(ROOT, sourceFile)} links outside the repository: ${rawTarget}`);
}

function assertLocalTarget(sourceFile, rawTarget) {
  if (/^(?:https?:|mailto:)/i.test(rawTarget)) return;
  const { filename, anchor } = resolveMarkdownTarget(sourceFile, rawTarget);
  assert.equal(fs.existsSync(filename), true, `${path.relative(ROOT, sourceFile)} links to missing ${rawTarget}`);
  assertRepositoryPath(sourceFile, filename, rawTarget);
  if (!anchor) return;
  const targetFile = fs.statSync(filename).isDirectory() ? path.join(filename, "README.md") : filename;
  assert.equal(fs.existsSync(targetFile), true, `${rawTarget} has no readable Markdown target`);
  assertRepositoryPath(sourceFile, targetFile, rawTarget);
  const anchors = headingAnchors(readMarkdown(targetFile));
  assert.equal(anchors.has(anchor), true, `${path.relative(ROOT, sourceFile)} links to missing anchor ${rawTarget}`);
}

function assertSlashCommandReferences(filename, source) {
  for (const match of source.matchAll(/\/(kimi):([A-Za-z0-9_-]+)/gi)) {
    const provider = match[1];
    const commandName = match[2];
    const reference = `/${provider}:${commandName}`;
    assert.match(reference, /^\/kimi:[a-z][a-z-]*$/, `${path.relative(ROOT, filename)} contains malformed slash command ${reference}`);
    const command = path.join(ROOT, "plugins", provider, "commands", `${commandName}.md`);
    assert.equal(fs.existsSync(command) && fs.statSync(command).isFile(), true, `${path.relative(ROOT, filename)} references missing ${reference}`);
  }
}

function commandArgumentHint(provider, commandName) {
  const filename = path.join(ROOT, "plugins", provider, "commands", `${commandName}.md`);
  const relative = path.relative(ROOT, filename);
  const source = readMarkdown(filename);
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, `${relative} is missing YAML frontmatter`);
  const hint = frontmatter[1].match(/^argument-hint:\s*"([^"]+)"$/m);
  assert.ok(hint, `${relative} is missing its quoted argument-hint`);
  return hint[1];
}

function parseTaskFrontmatter(source, relative) {
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, `${relative} is missing YAML frontmatter`);
  const lines = frontmatter[1].split("\n");
  const metaIndexes = lines.flatMap((line, index) => line === "meta:" ? [index] : []);
  assert.deepEqual(metaIndexes.length, 1, `${relative} must contain exactly one top-level meta object`);
  const meta = new Map();
  for (let index = metaIndexes[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (!line.startsWith("  ")) break;
    const field = /^  ([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line);
    assert.ok(field, `${relative} contains invalid meta syntax`);
    assert.equal(meta.has(field[1]), false, `${relative} duplicates meta.${field[1]}`);
    meta.set(field[1], field[2]);
  }
  for (const key of ["title", "navLabel", "category", "contentType"]) {
    assert.ok(meta.get(key), `${relative} is missing meta.${key}`);
  }
  const contentPlanLines = lines.flatMap((line) => {
    const match = /^contentPlan:\s*(\S+)$/.exec(line);
    return match ? [match[1]] : [];
  });
  assert.equal(contentPlanLines.length, 1, `${relative} must contain one top-level contentPlan`);
  return { meta, contentPlan: contentPlanLines[0] };
}

test("task documentation has complete metadata, titles, summaries, and content-plan links", () => {
  for (const filename of DOC_FILES) {
    const relative = path.relative(ROOT, filename);
    const source = readMarkdown(filename);
    const { meta, contentPlan } = parseTaskFrontmatter(source, relative);
    const title = meta.get("title");
    const contentType = meta.get("contentType");
    assert.equal(CONTENT_TYPES.has(contentType), true, `${relative} has an invalid meta.contentType`);
    assert.equal(source.match(/^#\s+(.+)$/m)?.[1], title, `${relative} H1 must match meta.title`);
    assert.ok(contentPlan, `${relative} is missing contentPlan`);
    assertLocalTarget(filename, contentPlan);

    const lines = source.slice(source.indexOf(`\n# ${title}\n`) + title.length + 4).split("\n");
    const opener = lines.find((line) => line.trim());
    assert.ok(opener && !/^(?:#|[-*+] |\d+\. |```|\|)/.test(opener.trim()), `${relative} must open with one summary paragraph`);
  }
});

test("documentation links and slash-command references resolve", () => {
  for (const filename of LINK_FILES) {
    const source = readMarkdown(filename);
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      assertLocalTarget(filename, match[1]);
    }
    assertSlashCommandReferences(filename, source);
  }
});

test("documentation prose and snippets retain the writing-guideline invariants", () => {
  for (const filename of PROSE_FILES) {
    const relative = path.relative(ROOT, filename);
    const source = readMarkdown(filename);
    const prose = proseWithoutCode(source);
    assert.doesNotMatch(prose, /\b(?:easy|simple|quick|very|just|really)\b/i, `${relative} contains a banned filler word`);
    assert.doesNotMatch(prose, /—|\.\.\./, `${relative} contains banned punctuation`);
    assert.doesNotMatch(prose, /\b[A-Za-z]+'(?:s|t|re|ve|ll|d|m)\b/, `${relative} contains a straight apostrophe in prose`);

    let openFence;
    let snippetLines = 0;
    for (const [index, line] of source.split("\n").entries()) {
      const fence = markdownFence(line);
      const closesFence = openFence
        && fence
        && fence.marker[0] === openFence[0]
        && fence.marker.length >= openFence.length
        && fence.info.trim() === "";
      if (!openFence && fence) {
        assert.match(fence.info, /^\S+$/, `${relative}:${index + 1} code fence needs a language tag`);
        openFence = fence.marker;
        snippetLines = 0;
      } else if (closesFence) {
        assert.equal(fence.info, "", `${relative}:${index + 1} closing code fence must be plain`);
        assert.ok(snippetLines <= 25, `${relative}:${index + 1} code block exceeds 25 lines`);
        openFence = undefined;
      } else if (openFence) {
        snippetLines += 1;
        assert.ok(line.length <= 80, `${relative}:${index + 1} code line exceeds 80 columns`);
      }
    }
    assert.equal(openFence, undefined, `${relative} has an unclosed code fence`);
  }
});

test("documentation home links every planned reader page", () => {
  const home = readMarkdown(path.join(DOCS_ROOT, "README.md"));
  for (const name of [
    "get-started.md",
    "command-reference.md",
    "manage-jobs-and-usage.md",
    "security-model.md",
    "structured-output-v2.md",
    "troubleshooting.md",
    "release-packages.md",
    "content-plan.md"
  ]) {
    assert.match(home, new RegExp(`\\(\\./${name.replace(".", "\\.")}\\)`), `docs/README.md does not link ${name}`);
  }
});

test("provider reference retains Kimi duration and job controls", () => {
  const reference = readMarkdown(path.join(DOCS_ROOT, "command-reference.md"));
  const jobs = readMarkdown(path.join(DOCS_ROOT, "manage-jobs-and-usage.md"));
  const kimiReadme = readMarkdown(path.join(ROOT, "plugins", "kimi", "README.md"));

  assert.match(reference, /Kimi accepts positive durations with `ms`, `s`, `m`, `h`, or `d`, including `250ms`\./);
  assert.match(reference, /A unitless Kimi duration means seconds\./);
  assert.match(kimiReadme, /A unitless duration means seconds\./);
  assert.match(commandArgumentHint("kimi", "status"), /\[--json\]/);
  assert.match(reference, /\/kimi:status/);
  assert.match(jobs, /\/kimi:status/);
});

test("documentation parsing handles portable Markdown boundaries", () => {
  const synthetic = [
    "---",
    "meta:",
    "  title: Portable Markdown",
    "---",
    "# Portable Markdown",
    "Keep `quick` as inline code.",
    "   ~~~text",
    "# Hidden fenced heading",
    "easy",
    "   ~~~",
    "## Visible heading",
    ""
  ].join("\r\n");
  const prose = proseWithoutCode(synthetic);
  assert.doesNotMatch(prose, /quick|easy|Hidden fenced heading/);
  assert.deepEqual([...headingAnchors(synthetic)], ["portable-markdown", "visible-heading"]);
  assert.deepEqual(markdownFence("   ```bash"), { marker: "```", info: "bash" });
  assert.deepEqual(markdownFence("   ~~~text"), { marker: "~~~", info: "text" });

  assert.throws(() => parseTaskFrontmatter([
    "---",
    "other:",
    "  title: Misnested",
    "  navLabel: Misnested",
    "  category: Test",
    "  contentType: Reference",
    "meta:",
    "contentPlan: ./content-plan.md",
    "---",
    ""
  ].join("\n"), "synthetic.md"), /missing meta\.title/);

  const sourceFile = path.join(DOCS_ROOT, "README.md");
  assert.throws(() => assertLocalTarget(sourceFile, "../.."), /links outside the repository/);
  assert.throws(() => assertSlashCommandReferences(sourceFile, "Run \/Kimi:ask."), /malformed slash command/);
  assert.throws(() => assertSlashCommandReferences(sourceFile, "Run \/kimi:not_real."), /malformed slash command/);
});
