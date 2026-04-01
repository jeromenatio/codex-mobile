const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");

const DATA_DIR = process.env.CODEX_MOBILE_DATA_DIR || path.join(__dirname, "data");
const SOCKET_PATH = process.env.CODEX_MOBILE_RUNTIME_SOCKET || path.join(DATA_DIR, "runtime.sock");
const STATE_FILE = process.env.CODEX_MOBILE_RUNTIME_STATE_FILE || path.join(DATA_DIR, "runtime-state.json");
const PID_FILE = process.env.CODEX_MOBILE_RUNTIME_PID_FILE || path.join(DATA_DIR, "runtime.pid");
const TEST_MODE = process.env.CODEX_MOBILE_TEST_MODE === "1";
const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
const CODEX_CONFIG_FILE = process.env.CODEX_MOBILE_CONFIG_FILE || path.join(CODEX_HOME_DIR, "config.toml");

const runs = new Map();
const server = http.createServer(handleRequest);

boot().catch((error) => {
  console.error("Runtime boot failed:", error);
  process.exit(1);
});

async function boot() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await loadState();
  await cleanupSocket();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, resolve);
  });
  await fsp.writeFile(PID_FILE, String(process.pid), "utf8");
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function shutdown() {
  try {
    server.close();
  } catch {}
  await cleanupSocket();
  await fsp.rm(PID_FILE, { force: true }).catch(() => {});
  process.exit(0);
}

async function cleanupSocket() {
  await fsp.rm(SOCKET_PATH, { force: true }).catch(() => {});
}

async function handleRequest(req, res) {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url === "/runs") {
      return sendJson(res, 200, {
        runs: [...runs.values()].map(serializeRun),
      });
    }

    if (req.method === "POST" && req.url === "/runs/start") {
      const body = await readJsonBody(req);
      const sessionId = String(body?.sessionId || "").trim();
      const workspacePath = String(body?.workspacePath || "").trim();
      const prompt = String(body?.prompt || "");
      const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
      const threadId = String(body?.threadId || "").trim() || null;

      if (!sessionId || !workspacePath) {
        return sendJson(res, 400, { error: "sessionId and workspacePath are required" });
      }

      const existing = runs.get(sessionId);
      if (existing?.status === "running") {
        return sendJson(res, 409, { error: "Run already active" });
      }

      const run = {
        sessionId,
        workspacePath,
        prompt,
        attachments,
        threadId,
        status: "running",
        pendingText: "",
        stderr: [],
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        code: null,
        interruptRequested: false,
        process: null,
      };

      runs.set(sessionId, run);
      await saveState();
      startRun(run);
      return sendJson(res, 200, { run: serializeRun(run) });
    }

    const interruptMatch = req.url?.match(/^\/runs\/([^/]+)\/interrupt$/);
    if (req.method === "POST" && interruptMatch) {
      const sessionId = decodeURIComponent(interruptMatch[1]);
      const run = runs.get(sessionId);
      if (!run || run.status !== "running") {
        return sendJson(res, 409, { error: "No running turn for this session" });
      }
      run.interruptRequested = true;
      run.process?.kill?.("SIGTERM");
      return sendJson(res, 200, { ok: true });
    }

    const ackMatch = req.url?.match(/^\/runs\/([^/]+)\/ack$/);
    if (req.method === "POST" && ackMatch) {
      const sessionId = decodeURIComponent(ackMatch[1]);
      const run = runs.get(sessionId);
      if (run && run.status !== "running") {
        runs.delete(sessionId);
        await saveState();
      }
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Runtime error" });
  }
}

function startRun(run) {
  if (TEST_MODE) {
    startFakeRun(run);
    return;
  }

  const args = buildCodexArgs(run);
  const child = spawn("codex", args, {
    cwd: run.workspacePath,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  run.process = child;

  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });

  stdout.on("line", (line) => {
    consumeCodexEvent(run, line);
  });

  stderr.on("line", (line) => {
    if (run.stderr.length >= 20) {
      run.stderr.shift();
    }
    run.stderr.push(line);
    run.updatedAt = new Date().toISOString();
    void saveState();
  });

  child.on("exit", (code) => {
    run.process = null;
    finalizeRun(run, { code, interrupted: Boolean(run.interruptRequested) });
  });
}

function startFakeRun(run) {
  const delay = run.prompt.includes("__SLOW__") ? 5000 : 120;
  const timer = setTimeout(() => {
    run.process = null;
    run.pendingText = buildFakeAssistantResponse(run.prompt, run.attachments);
    finalizeRun(run, { code: 0, interrupted: false });
  }, delay);

  run.process = {
    kill() {
      clearTimeout(timer);
      if (!run.process) {
        return;
      }
      run.process = null;
      run.interruptRequested = true;
      finalizeRun(run, { code: 0, interrupted: true });
    },
  };
}

function consumeCodexEvent(run, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (event.type === "thread.started" && event.thread_id) {
    run.threadId = String(event.thread_id);
    run.updatedAt = new Date().toISOString();
    void saveState();
    return;
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    run.pendingText = String(event.item.text || run.pendingText || "");
    run.updatedAt = new Date().toISOString();
    void saveState();
  }
}

function finalizeRun(run, { code = 0, interrupted = false }) {
  if (!String(run.pendingText || "").trim()) {
    run.pendingText =
      interrupted
        ? "Réponse interrompue."
        : code === 0
        ? "Réponse vide."
        : `La session Codex a échoué${run.stderr.length ? `: ${run.stderr.join(" ")}` : "."}`;
  }

  run.code = code;
  run.status = interrupted ? "interrupted" : code === 0 ? "completed" : "error";
  run.updatedAt = new Date().toISOString();
  run.completedAt = run.updatedAt;
  run.interruptRequested = false;
  void saveState();
}

function buildFakeAssistantResponse(prompt, attachments = []) {
  if (prompt.includes("__MARKDOWN__")) {
    return [
      "# Réponse de test",
      "",
      "- item 1",
      "- item 2",
      "",
      "```js",
      "console.log('ok');",
      "```",
    ].join("\n");
  }

  if (attachments.length) {
    return `Images reçues: ${attachments.length}`;
  }

  if (prompt.includes("__LONG__")) {
    return `Réponse longue\n\n${"ligne de test\n".repeat(30).trim()}`;
  }

  return `Réponse de test: ${prompt}`;
}

function buildCodexArgs(run) {
  const imageArgs = run.attachments.flatMap((attachment) => ["-i", attachment.path]);
  const prefixArgs = buildCodexPrefixArgs();

  if (run.threadId) {
    return [
      ...prefixArgs,
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      ...imageArgs,
      run.threadId,
      run.prompt,
    ];
  }

  return [
    ...prefixArgs,
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...imageArgs,
    "-C",
    run.workspacePath,
    run.prompt,
  ];
}

function buildCodexPrefixArgs() {
  const settings = readCodexConfigSettingsSync();
  return settings.search ? ["--search"] : [];
}

function readCodexConfigSettingsSync() {
  try {
    const text = fs.existsSync(CODEX_CONFIG_FILE) ? fs.readFileSync(CODEX_CONFIG_FILE, "utf8") : "";
    return {
      search: /^\s*search\s*=\s*true\s*$/m.test(text),
    };
  } catch {
    return { search: false };
  }
}

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, "utf8");
    const payload = JSON.parse(raw);
    const entries = Array.isArray(payload?.runs) ? payload.runs : [];
    for (const entry of entries) {
      const run = {
        sessionId: String(entry.sessionId || ""),
        workspacePath: String(entry.workspacePath || ""),
        prompt: String(entry.prompt || ""),
        attachments: Array.isArray(entry.attachments) ? entry.attachments : [],
        threadId: entry.threadId ? String(entry.threadId) : null,
        status: String(entry.status || "error"),
        pendingText: String(entry.pendingText || ""),
        stderr: Array.isArray(entry.stderr) ? entry.stderr : [],
        updatedAt: String(entry.updatedAt || new Date().toISOString()),
        startedAt: String(entry.startedAt || entry.updatedAt || new Date().toISOString()),
        completedAt: entry.completedAt ? String(entry.completedAt) : null,
        code: typeof entry.code === "number" ? entry.code : null,
        interruptRequested: false,
        process: null,
      };
      if (!run.sessionId) {
        continue;
      }
      if (run.status === "running") {
        run.status = "interrupted";
        run.pendingText = run.pendingText || "Réponse interrompue après redémarrage du runtime.";
        run.updatedAt = new Date().toISOString();
        run.completedAt = run.updatedAt;
      }
      runs.set(run.sessionId, run);
    }
    await saveState();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function saveState() {
  const payload = {
    runs: [...runs.values()].map(serializeRun),
  };
  await fsp.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function serializeRun(run) {
  return {
    sessionId: run.sessionId,
    workspacePath: run.workspacePath,
    prompt: run.prompt,
    attachments: run.attachments,
    threadId: run.threadId,
    status: run.status,
    pendingText: run.pendingText,
    stderr: run.stderr,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt || null,
    code: run.code,
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        if (!chunks.length) {
          resolve({});
          return;
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
