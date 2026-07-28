#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const fakeConfigIndex = args.indexOf("--fake-config");
let fakeConfiguration = {};
if (fakeConfigIndex >= 0 && args[fakeConfigIndex + 1]) {
  try { fakeConfiguration = JSON.parse(fs.readFileSync(args[fakeConfigIndex + 1], "utf8")); } catch { /* Defaults exercise the ordinary fixture. */ }
}
const fake = (name) => fakeConfiguration[name];

// Tests poll these record files and parse them immediately. A plain write lets
// a reader observe a partially written file, so publish by rename instead.
function writeRecord(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, typeof value === "string" ? value : JSON.stringify(value));
  fs.renameSync(temporary, file);
}

if (args.includes("--version") && fake("FAKE_PROBE_LEAVE_CHILD") === "1") {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  if (fake("FAKE_RECORD_FILE")) {
    writeRecord(fake("FAKE_RECORD_FILE"), { providerPid: process.pid, grandchildPid: grandchild.pid });
  }
  process.exit(0);
} else if (args.includes("--version") && fake("FAKE_PROBE_HANG_TREE") === "1") {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  if (fake("FAKE_RECORD_FILE")) {
    writeRecord(fake("FAKE_RECORD_FILE"), { providerPid: process.pid, grandchildPid: grandchild.pid });
  }
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else if (args.includes("--version") && fake("FAKE_PROBE_HANG") === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else if (args.includes("--version")) {
  if (fake("FAKE_VERSION_STDERR_BYTES")) {
    if (fake("FAKE_VERSION_STDERR_PREFIX")) process.stderr.write(fake("FAKE_VERSION_STDERR_PREFIX"));
    process.stderr.write(Buffer.alloc(Number(fake("FAKE_VERSION_STDERR_BYTES")), fake("FAKE_VERSION_STDERR_CHARACTER") || "v"));
  }
  if (fake("FAKE_VERSION_EXIT")) process.exit(Number(fake("FAKE_VERSION_EXIT")));
  process.stdout.write(`${fake("FAKE_PROVIDER_VERSION") || "9.9.9-test"}\n`);
  process.exit(0);
}

if (args.includes("--help")) {
  process.stdout.write(fake("FAKE_KIMI_AGENT_FILE") === "0"
    ? "Usage: kimi [options]\n"
    : `Usage: kimi [options]\n  --agent-file <file>  Load a custom agent\n  --skills-dir <dir>  Replace skill directories\n${fake("FAKE_KIMI_ADD_DIR") === "0" ? "" : "  --add-dir <dir>  Add a workspace directory\n"}`);
  process.exit(0);
}

if (args.includes("doctor")) {
  if (fake("FAKE_DOCTOR_STDERR_BYTES")) {
    process.on("SIGTERM", () => {});
    process.stderr.write(Buffer.alloc(Number(fake("FAKE_DOCTOR_STDERR_BYTES")), "x"));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (fake("FAKE_DOCTOR_FAIL") === "1") {
    process.stderr.write(`${fake("FAKE_DOCTOR_MESSAGE") || "configuration invalid"}\n`);
    process.exit(2);
  }
  process.stdout.write("configuration ok\n");
  process.exit(0);
}

if (args.includes("provider") && args.includes("list")) {
  process.stdout.write(fake("FAKE_PROVIDER_LIST_JSON") || JSON.stringify({
    models: {
      "kimi-test": {
        model: "kimi-test",
        display_name: "Kimi Test",
        max_context_size: 262144,
        capabilities: ["thinking", "tool_use"]
      }
    },
    credentials: { token: "must-not-be-returned" }
  }));
  process.stdout.write("\n");
  process.exit(0);
}

if (args.includes("acp")) {
  const requests = [];
  let serverRequestId = 10_000;
  let pendingPermission;
  const grandchild = fake("FAKE_ACP_LEAVE_CHILD") === "1"
    ? spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
    : undefined;
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  if (fake("FAKE_ACP_RAW_FRAME_BYTES")) {
    process.stdout.write(Buffer.alloc(Number(fake("FAKE_ACP_RAW_FRAME_BYTES")), "x"));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  const record = () => {
    if (fake("FAKE_RECORD_FILE")) writeRecord(fake("FAKE_RECORD_FILE"), {
      providerPid: process.pid,
      grandchildPid: grandchild?.pid || null,
      requests,
      environmentKeys: Object.keys(process.env).sort()
    }, null, 2);
  };
  const finishPrompt = (message) => {
    const output = fake("FAKE_ACP_OUTPUT_BYTES")
      ? Buffer.alloc(Number(fake("FAKE_ACP_OUTPUT_BYTES")), "x").toString("utf8")
      : fake("FAKE_ACP_OUTPUT") || "fake session response";
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: message.params?.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } }
    } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    requests.push(message);
    record();
    if (message.id != null && !message.method) {
      if (pendingPermission && message.id === pendingPermission.permissionId) {
        const pending = pendingPermission.message;
        pendingPermission = undefined;
        finishPrompt(pending);
      }
      continue;
    }
    if (message.id == null || !message.method) continue;
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: fake("FAKE_ACP_FORK_CAPABILITY") != null
            ? { fork: JSON.parse(fake("FAKE_ACP_FORK_CAPABILITY")) }
            : fake("FAKE_ACP_FORK") === "1" ? { fork: {} } : {}
        }
      } });
    } else if (message.method === "session/list") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        sessions: [
          { sessionId: "session-listed", title: fake("FAKE_ACP_SESSION_TITLE") || "Listed session", updatedAt: "2026-01-02T03:04:05.000Z" },
          { sessionId: "../invalid", title: "invalid", updatedAt: "invalid" }
        ],
        nextCursor: "next-page"
      } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-new" } });
    } else if (message.method === "session/resume" || message.method === "session/set_config_option") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === "session/fork" && fake("FAKE_ACP_FORK") === "1") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-forked" } });
    } else if (message.method === "session/prompt") {
      if (fake("FAKE_ACP_MODE") === "close") process.exit(7);
      if (fake("FAKE_ACP_MODE") === "hang") continue;
      if (fake("FAKE_ACP_PERMISSION") === "1") {
        const permissionId = serverRequestId++;
        pendingPermission = { permissionId, message };
        send({ jsonrpc: "2.0", id: permissionId, method: "session/request_permission", params: { sessionId: message.params?.sessionId } });
        continue;
      }
      finishPrompt(message);
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
    }
  }
  process.exit(0);
}

if (fake("FAKE_REQUIRED_ENV_JSON")) {
  const requiredEnvironment = JSON.parse(fake("FAKE_REQUIRED_ENV_JSON"));
  const mismatch = Object.entries(requiredEnvironment).find(([key, value]) => process.env[key] !== value);
  if (mismatch) {
    process.stderr.write(`environment mismatch for ${mismatch[0]}\n`);
    process.exit(86);
  }
}

let prompt = "";
if (process.env.MODEL_COMPANION_PROMPT_FILE && fs.existsSync(process.env.MODEL_COMPANION_PROMPT_FILE)) {
  prompt = fs.readFileSync(process.env.MODEL_COMPANION_PROMPT_FILE, "utf8");
} else {
  if (fake("FAKE_PROVIDER_DELAY_MS")) {
    await new Promise((resolve) => setTimeout(resolve, Number(fake("FAKE_PROVIDER_DELAY_MS"))));
  }
  for await (const chunk of process.stdin) prompt += chunk;
}

if (fake("FAKE_PROVIDER_HOLD_MS")) {
  await new Promise((resolve) => setTimeout(resolve, Number(fake("FAKE_PROVIDER_HOLD_MS"))));
}

if (fake("FAKE_PROVIDER_MODE") === "wait" || fake("FAKE_PROVIDER_MODE") === "leave-child") {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  await new Promise((resolve, reject) => {
    grandchild.stdout.once("data", resolve);
    grandchild.once("error", reject);
  });
  grandchild.stdout.destroy();
  grandchild.unref();
  if (fake("FAKE_RECORD_FILE")) {
    writeRecord(fake("FAKE_RECORD_FILE"), { providerPid: process.pid, grandchildPid: grandchild.pid });
  }
  if (fake("FAKE_PROVIDER_MODE") === "wait") setInterval(() => {}, 1000);
  else process.stdout.write(`${JSON.stringify({ prompt, providerPid: process.pid, grandchildPid: grandchild.pid })}\n`);
} else {
  const agentFileIndex = args.indexOf("--agent-file");
  const agentFile = agentFileIndex >= 0 ? args[agentFileIndex + 1] : undefined;
  const agentTemplate = agentFile && fs.existsSync(agentFile) ? fs.readFileSync(agentFile, "utf8") : null;
  const skillsDirectoryIndex = args.indexOf("--skills-dir");
  const skillsDirectory = skillsDirectoryIndex >= 0 ? args[skillsDirectoryIndex + 1] : undefined;
  const agentsFile = path.join(process.cwd(), "AGENTS.md");
  const agentsSource = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : "";
  const renderedAgentSource = agentTemplate?.replace(/\$\{([^}]+)\}/g, (match, name) => name === "agents_md" ? agentsSource : match) || null;
  const record = {
    args,
    cwd: process.cwd(),
    cwdReal: fs.realpathSync(process.cwd()),
    cwdEntries: fs.readdirSync(process.cwd()).sort(),
    agentTemplate,
    agentSource: renderedAgentSource,
    skillsDirectory,
    skillsDirectoryReal: skillsDirectory && fs.existsSync(skillsDirectory) ? fs.realpathSync(skillsDirectory) : null,
    skillsEntries: skillsDirectory && fs.existsSync(skillsDirectory) ? fs.readdirSync(skillsDirectory).sort() : null,
    prompt,
    experimental: process.env.KIMI_CODE_EXPERIMENTAL_FLAG || null,
    promptFile: process.env.MODEL_COMPANION_PROMPT_FILE || null,
    environmentKeys: Object.keys(process.env).sort()
  };
  if (fake("FAKE_RECORD_FILE")) writeRecord(fake("FAKE_RECORD_FILE"), JSON.stringify(record, null, 2));
  if (fake("FAKE_PROVIDER_HOLD_AFTER_RECORD_MS")) {
    await new Promise((resolve) => setTimeout(resolve, Number(fake("FAKE_PROVIDER_HOLD_AFTER_RECORD_MS"))));
  }
  if (fake("FAKE_PROVIDER_EXACT_STDOUT_BYTES")) {
    process.stdout.write(Buffer.alloc(Number(fake("FAKE_PROVIDER_EXACT_STDOUT_BYTES")), "e"));
    process.exit(Number(fake("FAKE_PROVIDER_EXACT_EXIT") || 0));
  }
  if (fake("FAKE_PROVIDER_RAW_OUTPUT")) process.stdout.write(fake("FAKE_PROVIDER_RAW_OUTPUT"));
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (fake("FAKE_PROVIDER_STDOUT_BYTES")) process.stdout.write(Buffer.alloc(Number(fake("FAKE_PROVIDER_STDOUT_BYTES")), "o"));
  if (fake("FAKE_PROVIDER_MODE") === "fail") {
    process.stderr.write(`${fake("FAKE_PROVIDER_DIAGNOSTIC") || "fake Kimi diagnostic"}\n`);
    process.exit(3);
  }
}
