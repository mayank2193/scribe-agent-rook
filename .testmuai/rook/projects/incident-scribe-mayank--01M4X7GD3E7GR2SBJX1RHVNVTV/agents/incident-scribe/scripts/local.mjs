import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const ENV = {
  token: process.env.SCRIBE_API_TOKEN,
  workspace: process.env.ROOK_WORKSPACE,
  conversation: process.env.ROOK_CONVERSATION,
};

function requireValue(value, name) {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function invoke(command, sessionId, input) {
  const token = requireValue(ENV.token, "SCRIBE_API_TOKEN");
  const cwd = requireValue(ENV.workspace, "ROOK_WORKSPACE");
  const args = [
    "-m",
    "incident_scribe",
    command,
    "--token",
    token,
    "--session-id",
    sessionId,
  ];

  const result = await new Promise((resolve, reject) => {
    const child = spawn("python3", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SCRIBE_API_TOKEN: ENV.token },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

  let body;
  try {
    body = JSON.parse(result.stdout.trim());
  } catch {
    const detail = result.stderr.trim().split("\n").at(-1) || result.stdout.trim() || "no output";
    throw new Error(`${command} returned invalid JSON: ${detail}`);
  }

  if (result.code !== 0 || body.ok !== true) {
    const detail = body.message || body.error || result.stderr.trim().split("\n").at(-1) || `exited ${result.code}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return body;
}

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function open() {
  const conversation = `rook-${randomUUID()}`;
  const body = await invoke("open", conversation);
  return { conversation: body.session_id };
}

async function execute() {
  const conversation = requireValue(ENV.conversation, "ROOK_CONVERSATION");
  const goal = await readStdin();
  const body = await invoke("execute", conversation, goal);
  if (typeof body.answer !== "string") throw new Error("execute reply did not contain a string at answer");
  return {
    agent_reply: body.answer,
    conversation,
    calls: Array.isArray(body.calls)
      ? body.calls.map((call) => ({ name: call.name, arguments: call.arguments }))
      : [],
    ...(body.usage && Number.isFinite(body.usage.input) && Number.isFinite(body.usage.output)
      ? { usage: { input: body.usage.input, output: body.usage.output } }
      : {}),
  };
}

async function close() {
  const conversation = requireValue(ENV.conversation, "ROOK_CONVERSATION");
  await invoke("close", conversation);
  return {};
}

async function collect() {
  const conversation = requireValue(ENV.conversation, "ROOK_CONVERSATION");
  const body = await invoke("logs", conversation);
  const calls = Array.isArray(body.entries)
    ? body.entries
        .filter((entry) => entry.event === "tool_call" && typeof entry.tool === "string")
        .map((entry) => ({ name: entry.tool, arguments: entry.arguments }))
    : [];
  return { calls, logs: body };
}

const PHASES = { open, execute, close, collect };
const fn = PHASES[process.argv[2]];
if (!fn) throw new Error(`unknown phase: ${process.argv[2]}`);
const result = await fn();
if (result) console.log(JSON.stringify(result));
