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
const AUTO_RETRY_TRANSIENT_ERROR_LIMIT = Math.max(0, Number(process.env.CODEX_MOBILE_TRANSIENT_ERROR_RETRY_LIMIT || 2));
const AUTO_RETRY_TRANSIENT_ERROR_DELAY_MS = Math.max(0, Number(process.env.CODEX_MOBILE_TRANSIENT_ERROR_RETRY_DELAY_MS || 700));
const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

const runs = new Map();
const server = http.createServer(handleRequest);
let savePromise = Promise.resolve();

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
  for (const run of runs.values()) {
    if (run.status === "running") {
      terminateRunProcess(run, "SIGTERM");
    }
  }
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
      await reconcileRuns();
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
        await reconcileRun(existing);
      }
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
        retryCount: 0,
        maxAutoRetries: AUTO_RETRY_TRANSIENT_ERROR_LIMIT,
        interruptRequested: false,
        attemptStderr: [],
        lastActivityAt: new Date().toISOString(),
        processPid: null,
        process: null,
        retryTimer: null,
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
      terminateRunProcess(run, "SIGTERM");
      if (!hasLiveRunProcess(run)) {
        finalizeRun(run, { code: 0, interrupted: true, allowRetry: false });
      }
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
  markRunActivity(run);
  if (run.retryTimer) {
    clearTimeout(run.retryTimer);
    run.retryTimer = null;
  }
  if (TEST_MODE) {
    startFakeRun(run);
    return;
  }

  const args = buildCodexArgs(run);
  const child = spawn("codex", args, {
    cwd: run.workspacePath,
    env: process.env,
    detached: SUPPORTS_PROCESS_GROUPS,
    stdio: ["ignore", "pipe", "pipe"],
  });

  run.attemptStderr = [];
  run.process = child;
  run.processPid = Number.isInteger(child.pid) ? child.pid : null;
  void saveState();

  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });

  stdout.on("line", (line) => {
    if (run.process !== child) {
      return;
    }
    markRunActivity(run);
    consumeCodexEvent(run, line);
  });

  stderr.on("line", (line) => {
    if (run.process !== child) {
      return;
    }
    if (run.stderr.length >= 20) {
      run.stderr.shift();
    }
    run.stderr.push(line);
    if (run.attemptStderr.length >= 20) {
      run.attemptStderr.shift();
    }
    run.attemptStderr.push(line);
    markRunActivity(run);
    void saveState();
  });

  child.on("error", (error) => {
    if (run.process !== child) {
      return;
    }
    run.process = null;
    run.processPid = null;
    pushRunStderr(run, error.message || "Failed to start codex");
    finalizeRun(run, { code: 1, interrupted: false });
  });

  child.on("exit", (code) => {
    if (run.process !== child) {
      return;
    }
    run.process = null;
    run.processPid = null;
    finalizeRun(run, { code, interrupted: Boolean(run.interruptRequested) });
  });
}

function startFakeRun(run) {
  if (!run.threadId) {
    run.threadId = `test-thread-${run.sessionId}`;
  }
  run.attemptStderr = [];
  const delay = run.prompt.includes("__SLOW__") ? 5000 : 120;
  const timer = setTimeout(() => {
    run.process = null;
    if (run.prompt.includes("__BAD_REQUEST_ONCE__") && run.retryCount === 0) {
      pushRunStderr(run, '{"detail":"Bad Request"}');
      finalizeRun(run, { code: 1, interrupted: false });
      return;
    }
    if (run.prompt.includes("__RATE_LIMIT_ONCE__") && run.retryCount === 0) {
      pushRunStderr(run, 'Error: 429 Too Many Requests');
      finalizeRun(run, { code: 1, interrupted: false });
      return;
    }
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
      run.processPid = null;
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
    markRunActivity(run);
    void saveState();
    return;
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    run.pendingText = String(event.item.text || run.pendingText || "");
    markRunActivity(run);
    void saveState();
  }
}

function finalizeRun(run, { code = 0, interrupted = false, allowRetry = true }) {
  if (run.status !== "running") {
    return;
  }

  if (run.retryTimer) {
    clearTimeout(run.retryTimer);
    run.retryTimer = null;
  }

  if (allowRetry && shouldRetryTransientError(run, { code, interrupted })) {
    scheduleTransientRetry(run);
    return;
  }

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
  run.attemptStderr = [];
  run.processPid = null;
  void saveState();
}

function pushRunStderr(run, line) {
  if (run.stderr.length >= 20) {
    run.stderr.shift();
  }
  run.stderr.push(line);
  if (run.attemptStderr.length >= 20) {
    run.attemptStderr.shift();
  }
  run.attemptStderr.push(line);
  markRunActivity(run);
}

function shouldRetryTransientError(run, { code = 0, interrupted = false }) {
  if (interrupted || code === 0) {
    return false;
  }
  if ((run.retryCount || 0) >= (run.maxAutoRetries || 0)) {
    return false;
  }
  const attemptOutput = run.attemptStderr.join("\n");
  return [
    /bad request/i,
    /\b429\b/,
    /too many requests/i,
    /\b5\d{2}\b/,
    /internal server error/i,
    /service unavailable/i,
    /gateway timeout/i,
    /timed? out/i,
    /timeout/i,
    /econnreset/i,
    /socket hang up/i,
    /temporary failure/i,
    /temporarily unavailable/i,
  ].some((pattern) => pattern.test(attemptOutput));
}

function scheduleTransientRetry(run) {
  run.retryCount = Number(run.retryCount || 0) + 1;
  run.code = null;
  run.completedAt = null;
  markRunActivity(run);
  run.interruptRequested = false;
  const reason = summarizeTransientError(run.attemptStderr);
  const message = `Erreur transitoire Codex (${reason}), relance automatique ${run.retryCount}/${run.maxAutoRetries}.`;
  pushRunStderr(run, message);
  void saveState();
  run.retryTimer = setTimeout(() => {
    run.retryTimer = null;
    if (run.status !== "running" || run.process) {
      return;
    }
    startRun(run);
  }, AUTO_RETRY_TRANSIENT_ERROR_DELAY_MS);
}

function summarizeTransientError(lines = []) {
  const text = lines.join("\n");
  if (/bad request/i.test(text)) {
    return "Bad Request";
  }
  if (/\b429\b/.test(text) || /too many requests/i.test(text)) {
    return "429";
  }
  if (/\b5\d{2}\b/.test(text)) {
    const match = text.match(/\b5\d{2}\b/);
    return match ? match[0] : "5xx";
  }
  if (/timed? out/i.test(text) || /timeout/i.test(text)) {
    return "timeout";
  }
  if (/econnreset/i.test(text) || /socket hang up/i.test(text)) {
    return "connexion reinitialisee";
  }
  return "retryable";
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
    return `Pièces jointes reçues: ${attachments.length}`;
  }

  if (prompt.includes("__LONG__")) {
    return `Réponse longue\n\n${"ligne de test\n".repeat(30).trim()}`;
  }

  return `Réponse de test: ${prompt}`;
}

function buildCodexArgs(run) {
  const imageArgs = collectImageAttachmentPaths(run.attachments)
    .flatMap((imagePath) => ["-i", imagePath]);
  const promptWithAttachments = buildPromptWithAttachments(run.prompt, run.attachments);
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
      promptWithAttachments,
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
    promptWithAttachments,
  ];
}

function buildPromptWithAttachments(prompt, attachments = []) {
  if (!attachments.length) {
    return prompt;
  }

  const lines = attachments.map((attachment) => `- ${attachment.relativePath || attachment.path}`);
  const extractedSections = attachments
    .flatMap((attachment) => buildAttachmentContextSections(attachment))
    .filter(Boolean);

  return [
    prompt,
    "",
    "Pièces jointes disponibles dans le workspace :",
    ...lines,
    ...extractedSections,
  ].join("\n").trim();
}

function collectImageAttachmentPaths(attachments = []) {
  const paths = [];
  for (const attachment of attachments) {
    if (attachment?.isImage && attachment?.path) {
      paths.push(attachment.path);
    }
    for (const derived of Array.isArray(attachment?.extractedImages) ? attachment.extractedImages : []) {
      if (derived?.path) {
        paths.push(derived.path);
      }
    }
    for (const entryPath of collectImageAttachmentPaths(Array.isArray(attachment?.extractedEntries) ? attachment.extractedEntries : [])) {
      paths.push(entryPath);
    }
  }
  return paths;
}

function buildAttachmentContextSections(attachment) {
  const sections = [];
  const derivedImages = Array.isArray(attachment?.extractedImages) ? attachment.extractedImages : [];
  if (derivedImages.length) {
    sections.push(
      "",
      `Images extraites depuis ${attachment.name || attachment.relativePath || attachment.path} :`,
      ...derivedImages.map((image) => `- ${image.relativePath || image.path}`)
    );
  }

  const extractedText = String(attachment?.extractedText || "").trim();
  if (extractedText) {
    sections.push(
      "",
      `Texte extrait de ${attachment.name || attachment.relativePath || attachment.path} :`,
      truncateAttachmentText(extractedText)
    );
  }

  const extractedEntries = Array.isArray(attachment?.extractedEntries) ? attachment.extractedEntries : [];
  if (extractedEntries.length) {
    sections.push(
      "",
      `Contenu extrait de ${attachment.name || attachment.relativePath || attachment.path} :`,
      ...(attachment.extractedDirPath ? [`Dossier extrait : ${attachment.extractedDirPath}`] : []),
      ...extractedEntries.slice(0, 60).map((entry) => `- ${entry.relativePath || entry.path}`),
      ...buildNestedAttachmentSections(extractedEntries)
    );
  }

  return sections;
}

function buildNestedAttachmentSections(entries) {
  const sections = [];
  let remainingTextBudget = TEXT_CONTEXT_BUDGET;
  for (const entry of entries) {
    const derivedImages = Array.isArray(entry?.extractedImages) ? entry.extractedImages : [];
    if (derivedImages.length) {
      sections.push(
        "",
        `Images extraites depuis ${entry.name || entry.relativePath || entry.path} :`,
        ...derivedImages.map((image) => `- ${image.relativePath || image.path}`)
      );
    }

    const extractedText = String(entry?.extractedText || "").trim();
    if (extractedText && remainingTextBudget > 0) {
      const chunk = truncateAttachmentText(extractedText, remainingTextBudget);
      sections.push(
        "",
        `Texte extrait de ${entry.name || entry.relativePath || entry.path} :`,
        chunk
      );
      remainingTextBudget -= chunk.length;
    }
  }
  return sections;
}

const TEXT_CONTEXT_BUDGET = 12000;

function truncateAttachmentText(text, maxLength = 6000) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}\n\n[texte tronqué]`;
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
        retryCount: Number(entry.retryCount || 0),
        maxAutoRetries: Number(entry.maxAutoRetries || AUTO_RETRY_TRANSIENT_ERROR_LIMIT),
        interruptRequested: false,
        attemptStderr: [],
        lastActivityAt: String(entry.lastActivityAt || entry.updatedAt || entry.startedAt || new Date().toISOString()),
        processPid: Number.isInteger(entry.processPid) ? entry.processPid : null,
        process: null,
        retryTimer: null,
      };
      if (!run.sessionId) {
        continue;
      }
      if (run.status === "running") {
        terminatePersistedProcess(run.processPid);
        run.status = "interrupted";
        run.pendingText = run.pendingText || "Réponse interrompue après redémarrage du runtime.";
        run.updatedAt = new Date().toISOString();
        run.completedAt = run.updatedAt;
        run.processPid = null;
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
  const currentSave = savePromise
    .catch(() => {})
    .then(async () => {
      const payload = {
        runs: [...runs.values()].map(serializeRun),
      };
      await fsp.writeFile(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
    });
  savePromise = currentSave.catch(() => {});
  return currentSave;
}

async function reconcileRuns() {
  let changed = false;
  for (const run of runs.values()) {
    changed = (await reconcileRun(run)) || changed;
  }
  return changed;
}

async function reconcileRun(run) {
  if (!run || run.status !== "running" || hasLiveRunProcess(run)) {
    return false;
  }
  finalizeRun(run, {
    code: 0,
    interrupted: true,
    allowRetry: false,
  });
  await saveState();
  return true;
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
    retryCount: Number(run.retryCount || 0),
    maxAutoRetries: Number(run.maxAutoRetries || AUTO_RETRY_TRANSIENT_ERROR_LIMIT),
    lastActivityAt: run.lastActivityAt || run.updatedAt,
    processPid: Number.isInteger(run.processPid) ? run.processPid : null,
  };
}

function markRunActivity(run) {
  const now = new Date().toISOString();
  run.updatedAt = now;
  run.lastActivityAt = now;
}

function hasLiveRunProcess(run) {
  if (!run || run.status !== "running") {
    return false;
  }
  if (run.retryTimer) {
    return true;
  }
  if (run.process) {
    return true;
  }
  return isPidAlive(run.processPid);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function terminateRunProcess(run, signal = "SIGTERM") {
  if (!run) {
    return;
  }
  if (run.retryTimer) {
    clearTimeout(run.retryTimer);
    run.retryTimer = null;
  }
  const processRef = run.process;
  const pid = Number.isInteger(run.processPid) ? run.processPid : run.process?.pid;
  if (!pid || pid <= 0) {
    try {
      processRef?.kill?.(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        console.error("Failed to terminate Codex child:", error);
      }
    }
    run.process = null;
    run.processPid = null;
    return;
  }
  run.process = null;
  run.processPid = null;
  try {
    if (SUPPORTS_PROCESS_GROUPS) {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.error("Failed to terminate Codex child:", error);
    }
  }
}

function terminatePersistedProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    if (SUPPORTS_PROCESS_GROUPS) {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.error("Failed to terminate persisted Codex child:", error);
    }
  }
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
