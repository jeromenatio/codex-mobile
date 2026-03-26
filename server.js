const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 4180);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const WORKSPACES_DIR = "/projects";
const CODEX_CONFIG_FILE = "/root/.codex/config.toml";
const CODEX_MODELS_CACHE_FILE = "/root/.codex/models_cache.json";

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

app.use(express.json({ limit: "25mb" }));
app.use("/assets/bootstrap-icons", express.static(path.join(ROOT_DIR, "node_modules", "bootstrap-icons"), {
  setHeaders: setNoCacheHeaders,
}));
app.use("/assets/marked", express.static(path.join(ROOT_DIR, "node_modules", "marked", "lib"), {
  setHeaders: setNoCacheHeaders,
}));
app.use(express.static(path.join(ROOT_DIR, "public"), {
  setHeaders: setNoCacheHeaders,
}));

const runtimes = new Map();
let persistedState = loadState();

boot().catch((error) => {
  console.error("Boot failed:", error);
  process.exit(1);
});

async function boot() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  await fsp.mkdir(WORKSPACES_DIR, { recursive: true });

  persistedState.sessions = Array.isArray(persistedState.sessions) ? persistedState.sessions : [];
  persistedState.lastSessionId = persistedState.lastSessionId || null;
  persistedState.hiddenSessionIds = Array.isArray(persistedState.hiddenSessionIds) ? persistedState.hiddenSessionIds : [];

  let changed = false;
  for (const session of persistedState.sessions) {
    session.messages = Array.isArray(session.messages) ? session.messages : [];
    session.name = typeof session.name === "string" && session.name.trim() ? session.name.trim() : session.workspaceName;

    const lastMessage = session.messages.at(-1);
    if (session.status === "running") {
      session.status = "interrupted";
      session.updatedAt = new Date().toISOString();
      changed = true;
    }

    if (session.status === "interrupted" && lastMessage?.role === "assistant" && lastMessage?.pending) {
      lastMessage.pending = false;
      lastMessage.text = lastMessage.text?.trim() || "Réponse interrompue après rechargement du serveur.";
      changed = true;
    }
  }

  if (changed) {
    await saveState();
  }

  syncExternalCodexSessions();

  registerRoutes();
  registerWebsocket();

  server.listen(PORT, () => {
    console.log(`Codex Mobile listening on http://0.0.0.0:${PORT}`);
  });
}

function registerRoutes() {
  app.get("/api/bootstrap", (_req, res) => {
    res.json(buildBootstrap());
  });

  app.get("/api/config/codex", async (_req, res) => {
    try {
      res.json(await readCodexConfigSettings());
    } catch (error) {
      console.error("Failed to read Codex config:", error);
      res.status(500).json({ error: error.message || "Failed to read Codex config" });
    }
  });

  app.put("/api/config/codex", async (req, res) => {
    try {
      const settings = {
        model: String(req.body?.model || "").trim() || null,
        sandboxDangerFullAccess: Boolean(req.body?.sandboxDangerFullAccess),
        approvalNever: Boolean(req.body?.approvalNever),
        hideFullAccessWarning: Boolean(req.body?.hideFullAccessWarning),
        search: Boolean(req.body?.search),
      };

      const updated = await writeCodexConfigSettings(settings);
      res.json(updated);
    } catch (error) {
      console.error("Failed to update Codex config:", error);
      res.status(500).json({ error: error.message || "Failed to update Codex config" });
    }
  });

  app.post("/api/sessions", async (req, res) => {
    try {
      const workspaceInput = String(req.body?.workspace || "").trim();
      const prompt = String(req.body?.prompt || "").trim();

      if (!workspaceInput) {
        return res.status(400).json({ error: "workspace is required" });
      }

      const session = await createSession(workspaceInput, prompt);
      res.status(201).json({ session, bootstrap: buildBootstrap() });
    } catch (error) {
      console.error("Failed to create session:", error);
      res.status(500).json({ error: error.message || "Failed to create session" });
    }
  });

  app.patch("/api/sessions/:sessionId", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      const name = String(req.body?.name || "").trim();

      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      if (!name) {
        return res.status(400).json({ error: "name is required" });
      }

      session.name = name;
      session.updatedAt = new Date().toISOString();
      await saveState();

      res.json({ session: sanitizeSession(session), bootstrap: buildBootstrap() });
    } catch (error) {
      console.error("Failed to rename session:", error);
      res.status(500).json({ error: error.message || "Failed to rename session" });
    }
  });

  app.delete("/api/sessions/:sessionId", async (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      const sessionIndex = persistedState.sessions.findIndex((session) => session.id === sessionId);

      if (sessionIndex === -1) {
        return res.status(404).json({ error: "Session not found" });
      }

      const runtime = runtimes.get(sessionId);
      if (runtime?.process) {
        runtime.process.kill("SIGTERM");
      }

      const session = persistedState.sessions[sessionIndex];
      const hiddenIds = new Set(persistedState.hiddenSessionIds);
      hiddenIds.add(session.id);
      if (session.threadId) {
        hiddenIds.add(session.threadId);
      }
      persistedState.hiddenSessionIds = [...hiddenIds];

      persistedState.sessions.splice(sessionIndex, 1);

      if (persistedState.lastSessionId === sessionId) {
        persistedState.lastSessionId = persistedState.sessions[0]?.id || null;
      }

      await saveState();
      res.json({ ok: true, bootstrap: buildBootstrap() });
    } catch (error) {
      console.error("Failed to delete session:", error);
      res.status(500).json({ error: error.message || "Failed to delete session" });
    }
  });

  app.post("/api/sessions/:sessionId/message", async (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      const session = findSession(sessionId);
      const text = String(req.body?.text || "").trim();
      const attachmentsInput = Array.isArray(req.body?.attachments) ? req.body.attachments : [];

      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      if (!text && attachmentsInput.length === 0) {
        return res.status(400).json({ error: "text or attachments are required" });
      }

      if (runtimes.get(sessionId)?.process) {
        return res.status(409).json({ error: "Codex is already processing this session" });
      }

      const attachments = await persistAttachments(sessionId, attachmentsInput);
      await appendUserMessage(session, text, attachments);
      runSessionTurn(session, text, attachments);

      res.json({ ok: true, session: sanitizeSession(session) });
    } catch (error) {
      console.error("Failed to send message:", error);
      res.status(500).json({ error: error.message || "Failed to send message" });
    }
  });
}

function registerWebsocket() {
  wss.on("connection", (socket, req) => {
    void handleWebsocketConnection(socket, req);
  });
}

async function handleWebsocketConnection(socket, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");
    const session = findSession(sessionId);

    if (!session) {
      socket.close(1008, "Unknown session");
      return;
    }

    await hydrateSessionMessages(session);

    const runtime = ensureRuntimeShell(sessionId);
    runtime.clients.add(socket);
    persistedState.lastSessionId = sessionId;
    void saveState();

    socket.send(
      JSON.stringify({
        type: "bootstrap",
        session: sanitizeSession(session),
        messages: session.messages,
      })
    );

    socket.on("close", () => {
      runtime.clients.delete(socket);
      if (!runtime.process && runtime.clients.size === 0) {
        runtimes.delete(sessionId);
      }
    });
}

async function createSession(workspaceLabel, initialPrompt) {
  const workspace = await ensureWorkspace(workspaceLabel);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const session = {
    id,
    name: workspace.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    createdAt,
    updatedAt: createdAt,
    status: "idle",
    threadId: null,
    messages: [],
  };

  persistedState.sessions.unshift(session);
  persistedState.lastSessionId = id;
  await saveState();

  if (initialPrompt) {
    await appendUserMessage(session, initialPrompt);
    runSessionTurn(session, initialPrompt);
  }

  return sanitizeSession(session);
}

async function appendUserMessage(session, text, attachments = []) {
  session.messages.push({
    id: crypto.randomUUID(),
    role: "user",
    text,
    attachments,
    createdAt: new Date().toISOString(),
  });
  session.updatedAt = new Date().toISOString();
  session.status = "running";
  persistedState.lastSessionId = session.id;
  await saveState();
  broadcastToSession(session.id, {
    type: "message",
    message: session.messages.at(-1),
    session: sanitizeSession(session),
  });
}

function runSessionTurn(session, prompt, attachments = []) {
  const args = buildCodexArgs(session, prompt, attachments);
  const child = spawn("codex", args, {
    cwd: session.workspacePath,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const runtime = ensureRuntimeShell(session.id);
  runtime.process = child;

  const pendingMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
    pending: true,
  };

  session.messages.push(pendingMessage);
  session.status = "running";
  session.updatedAt = new Date().toISOString();
  void saveState();
  broadcastToSession(session.id, {
    type: "message",
    message: pendingMessage,
    session: sanitizeSession(session),
  });

  const lines = readline.createInterface({ input: child.stdout });
  const errLines = readline.createInterface({ input: child.stderr });

  lines.on("line", (line) => {
    consumeCodexEvent(session, pendingMessage, line);
  });

  errLines.on("line", (line) => {
    runtime.stderr.push(line);
  });

  child.on("exit", async (code) => {
    runtime.process = null;

    if (!pendingMessage.text.trim()) {
      pendingMessage.text =
        code === 0
          ? "Réponse vide."
          : `La session Codex a échoué${runtime.stderr.length ? `: ${runtime.stderr.join(" ")}` : "."}`;
    }

    pendingMessage.pending = false;
    session.status = code === 0 ? "idle" : "error";
    session.updatedAt = new Date().toISOString();

    broadcastToSession(session.id, {
      type: "message.updated",
      message: pendingMessage,
      session: sanitizeSession(session),
    });

    broadcastToSession(session.id, {
      type: "status",
      session: sanitizeSession(session),
    });

    runtime.stderr = [];
    await saveState();

    if (runtime.clients.size === 0) {
      runtimes.delete(session.id);
    }
  });
}

function consumeCodexEvent(session, pendingMessage, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (event.type === "thread.started" && event.thread_id) {
    session.threadId = event.thread_id;
    void saveState();
    return;
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    pendingMessage.text = event.item.text || pendingMessage.text;
    session.updatedAt = new Date().toISOString();
    broadcastToSession(session.id, {
      type: "message.updated",
      message: pendingMessage,
      session: sanitizeSession(session),
    });
  }
}

function buildCodexArgs(session, prompt, attachments = []) {
  const imageArgs = attachments.flatMap((attachment) => ["-i", attachment.path]);
  const prefixArgs = buildCodexPrefixArgs();
  if (session.threadId) {
    return [
      ...prefixArgs,
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      ...imageArgs,
      session.threadId,
      prompt,
    ];
  }

  return [
    ...prefixArgs,
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...imageArgs,
    "-C",
    session.workspacePath,
    prompt,
  ];
}

function buildCodexPrefixArgs() {
  const settings = readCodexConfigSettingsSync();
  return settings.search ? ["--search"] : [];
}

async function persistAttachments(sessionId, attachmentsInput) {
  const persisted = [];

  for (const attachment of attachmentsInput) {
    const name = String(attachment?.name || "image").trim() || "image";
    const dataUrl = String(attachment?.dataUrl || "");

    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      continue;
    }

    const [, mimeType, base64] = match;
    const extension = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "") || "png";
    const dir = path.join(UPLOADS_DIR, sessionId);
    await fsp.mkdir(dir, { recursive: true });

    const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const filePath = path.join(dir, filename);
    await fsp.writeFile(filePath, Buffer.from(base64, "base64"));

    persisted.push({
      id: crypto.randomUUID(),
      name,
      mimeType,
      path: filePath,
    });
  }

  return persisted;
}

async function ensureWorkspace(label) {
  const id = slugify(label) || `workspace-${Date.now()}`;
  const workspacePath = path.join(WORKSPACES_DIR, id);
  await fsp.mkdir(workspacePath, { recursive: true });

  return {
    id,
    name: label,
    path: workspacePath,
  };
}

function buildBootstrap() {
  syncExternalCodexSessions();

  const sessions = persistedState.sessions
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(sanitizeSession);

  const workspaces = new Map();
  for (const session of sessions) {
    if (!workspaces.has(session.workspaceId)) {
      workspaces.set(session.workspaceId, {
        id: session.workspaceId,
        name: session.workspaceName,
        path: session.workspacePath,
        sessions: 0,
      });
    }
    workspaces.get(session.workspaceId).sessions += 1;
  }

  return {
    lastSessionId: persistedState.lastSessionId || sessions[0]?.id || null,
    sessions,
    workspaces: [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function findSession(sessionId) {
  return persistedState.sessions.find((session) => session.id === sessionId);
}

function sanitizeSession(session) {
  return {
    id: session.id,
    name: session.name || session.workspaceName,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    workspacePath: session.workspacePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: runtimes.get(session.id)?.process ? "running" : session.status,
    threadId: session.threadId || null,
    messageCount: session.messages.length,
  };
}

function ensureRuntimeShell(sessionId) {
  if (!runtimes.has(sessionId)) {
    runtimes.set(sessionId, {
      clients: new Set(),
      process: null,
      stderr: [],
    });
  }
  return runtimes.get(sessionId);
}

function broadcastToSession(sessionId, message) {
  const runtime = ensureRuntimeShell(sessionId);
  const payload = JSON.stringify(message);
  for (const client of runtime.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { sessions: [], lastSessionId: null, hiddenSessionIds: [] };
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (error) {
    console.error("Failed to load state:", error);
    return { sessions: [], lastSessionId: null, hiddenSessionIds: [] };
  }
}

async function readCodexConfigSettings() {
  const text = await readCodexConfigText();
  return parseCodexConfigSettings(text);
}

async function readCodexConfigText() {
  try {
    return await fsp.readFile(CODEX_CONFIG_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function readCodexConfigSettingsSync() {
  try {
    const text = fs.existsSync(CODEX_CONFIG_FILE) ? fs.readFileSync(CODEX_CONFIG_FILE, "utf8") : "";
    return parseCodexConfigSettings(text);
  } catch {
    return parseCodexConfigSettings("");
  }
}

function parseCodexConfigSettings(text) {
  return {
    model: parseTopLevelTomlString(text, "model") || "gpt-5.4",
    availableModels: readAvailableModels(),
    sandboxDangerFullAccess: /^\s*sandbox_mode\s*=\s*"danger-full-access"\s*$/m.test(text),
    approvalNever: /^\s*approval_policy\s*=\s*"never"\s*$/m.test(text),
    hideFullAccessWarning: /^\s*hide_full_access_warning\s*=\s*true\s*$/m.test(text),
    search: /^\s*search\s*=\s*true\s*$/m.test(text),
  };
}

async function writeCodexConfigSettings(settings) {
  let text = await readCodexConfigText();

  text = setOrRemoveTopLevelTomlString(text, "model", settings.model || "gpt-5.4");
  text = setOrRemoveTopLevelTomlString(text, "sandbox_mode", settings.sandboxDangerFullAccess ? "danger-full-access" : null);
  text = setOrRemoveTopLevelTomlString(text, "approval_policy", settings.approvalNever ? "never" : null);
  text = setOrRemoveTopLevelTomlBoolean(text, "search", settings.search);
  text = setOrRemoveSectionTomlBoolean(text, "notice", "hide_full_access_warning", settings.hideFullAccessWarning);
  text = `${text.trimEnd()}\n`;

  await fsp.mkdir(path.dirname(CODEX_CONFIG_FILE), { recursive: true });
  await fsp.writeFile(CODEX_CONFIG_FILE, text, "utf8");

  return parseCodexConfigSettings(text);
}

function setOrRemoveTopLevelTomlBoolean(text, key, enabled) {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*$\\n?`, "m");
  if (!enabled) {
    return text.replace(pattern, "");
  }
  const line = `${key} = true`;
  if (pattern.test(text)) {
    return text.replace(pattern, `${line}\n`);
  }
  return `${line}\n${text}`;
}

function setOrRemoveTopLevelTomlString(text, key, value) {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*".*"\\s*$\\n?`, "m");
  if (value == null) {
    return text.replace(pattern, "");
  }
  const line = `${key} = "${value}"`;
  if (pattern.test(text)) {
    return text.replace(pattern, `${line}\n`);
  }
  return `${line}\n${text}`;
}

function parseTopLevelTomlString(text, key) {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  return match ? match[1] : "";
}

function setOrRemoveSectionTomlBoolean(text, sectionName, key, enabled) {
  const sectionPattern = new RegExp(`(^\\[${escapeRegExp(sectionName)}\\]\\n)([\\s\\S]*?)(?=^\\[[^\\n]+\\]\\n|$)`, "m");
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*$\\n?`, "m");

  if (sectionPattern.test(text)) {
    return text.replace(sectionPattern, (_match, header, body) => {
      let nextBody = body;

      if (enabled) {
        if (keyPattern.test(nextBody)) {
          nextBody = nextBody.replace(keyPattern, `${key} = true\n`);
        } else {
          nextBody = `${key} = true\n${nextBody}`;
        }
      } else {
        nextBody = nextBody.replace(keyPattern, "");
      }

      nextBody = nextBody.replace(/^\n+/, "");
      return `${header}${nextBody ? (nextBody.endsWith("\n") ? nextBody : `${nextBody}\n`) : ""}`;
    });
  }

  if (!enabled) {
    return text;
  }

  const prefix = text.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}[${sectionName}]\n${key} = true\n`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readAvailableModels() {
  try {
    if (!fs.existsSync(CODEX_MODELS_CACHE_FILE)) {
      return [];
    }

    const raw = JSON.parse(fs.readFileSync(CODEX_MODELS_CACHE_FILE, "utf8"));
    const models = Array.isArray(raw?.models) ? raw.models : [];

    return models
      .filter((model) => model?.slug)
      .filter((model) => model.visibility !== "hidden")
      .sort((left, right) => Number(left.priority || 999) - Number(right.priority || 999))
      .map((model) => ({
        slug: String(model.slug),
        label: String(model.display_name || model.slug),
        description: String(model.description || ""),
      }));
  } catch (error) {
    console.error("Failed to read available Codex models:", error);
    return [];
  }
}

function setNoCacheHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function syncExternalCodexSessions() {
  const threads = readCodexThreads();
  if (!threads.length) {
    return;
  }

  const hiddenIds = new Set(persistedState.hiddenSessionIds || []);

  for (const thread of threads) {
    if (hiddenIds.has(thread.threadId)) {
      continue;
    }

    const existing = persistedState.sessions.find(
      (session) => session.threadId === thread.threadId || session.id === thread.threadId
    );

    if (existing) {
      existing.workspaceId = existing.workspaceId || thread.workspaceId;
      existing.workspaceName = existing.workspaceName || thread.workspaceName;
      existing.workspacePath = existing.workspacePath || thread.workspacePath;
      existing.name = existing.name || thread.name;
      existing.createdAt = existing.createdAt || thread.createdAt;
      existing.updatedAt = newerIso(existing.updatedAt, thread.updatedAt);
      existing.threadId = existing.threadId || thread.threadId;
      existing.rolloutPath = existing.rolloutPath || thread.rolloutPath;
      existing.messages = Array.isArray(existing.messages) ? existing.messages : [];
      continue;
    }

    persistedState.sessions.push({
      id: thread.threadId,
      name: thread.name,
      workspaceId: thread.workspaceId,
      workspaceName: thread.workspaceName,
      workspacePath: thread.workspacePath,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: "idle",
      threadId: thread.threadId,
      rolloutPath: thread.rolloutPath,
      messages: [],
      imported: true,
    });
  }
}

function readCodexThreads() {
  const script = `
import json, sqlite3
from pathlib import Path

db = Path("/root/.codex/state_5.sqlite")
if not db.exists():
    print("[]")
    raise SystemExit(0)

con = sqlite3.connect(str(db))
cur = con.cursor()
rows = cur.execute(
    "select id, cwd, title, created_at, updated_at, rollout_path from threads where archived = 0 and cwd like '/projects/%' order by updated_at desc"
).fetchall()

items = []
for thread_id, cwd, title, created_at, updated_at, rollout_path in rows:
    rel = cwd[len('/projects/'):]
    if not rel:
        continue
    workspace = rel.split('/', 1)[0]
    if not workspace:
        continue
    items.append({
        "threadId": thread_id,
        "workspaceId": workspace,
        "workspaceName": workspace,
        "workspacePath": cwd,
        "name": title or workspace,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "rolloutPath": rollout_path,
    })

print(json.dumps(items))
`;

  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }

  try {
    const rows = JSON.parse(result.stdout);
    return rows.map((row) => ({
      threadId: row.threadId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workspacePath: row.workspacePath,
      name: row.name,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      rolloutPath: row.rolloutPath,
    }));
  } catch (error) {
    console.error("Failed to parse external Codex threads:", error);
    return [];
  }
}

function toIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return new Date().toISOString();
  }

  const millis = number > 10_000_000_000 ? number : number * 1000;
  return new Date(millis).toISOString();
}

function newerIso(left, right) {
  if (!left) return right;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

async function hydrateSessionMessages(session) {
  if (!session?.threadId) {
    return;
  }

  if (Array.isArray(session.messages) && session.messages.length > 0) {
    return;
  }

  const rolloutPath = session.rolloutPath || lookupRolloutPath(session.threadId);
  if (!rolloutPath || !fs.existsSync(rolloutPath)) {
    return;
  }

  const raw = await fsp.readFile(rolloutPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const messages = [];

  for (const line of lines) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    if (item.type !== "event_msg" || !item.payload) {
      continue;
    }

    if (item.payload.type === "user_message") {
      messages.push({
        id: crypto.randomUUID(),
        role: "user",
        text: String(item.payload.message || ""),
        attachments: [],
        createdAt: item.timestamp || new Date().toISOString(),
      });
      continue;
    }

    if (item.payload.type === "agent_message" && item.payload.phase === "final_answer") {
      messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        text: String(item.payload.message || ""),
        createdAt: item.timestamp || new Date().toISOString(),
        pending: false,
      });
    }
  }

  session.messages = messages;
  await saveState();
}

function lookupRolloutPath(threadId) {
  const script = `
import sqlite3
con = sqlite3.connect("/root/.codex/state_5.sqlite")
cur = con.cursor()
row = cur.execute("select rollout_path from threads where id = ?", ("${threadId}",)).fetchone()
print(row[0] if row else "")
`;

  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

let savePromise = Promise.resolve();
function saveState() {
  savePromise = savePromise.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(STATE_FILE, JSON.stringify(persistedState, null, 2));
  });
  return savePromise;
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-");
}
