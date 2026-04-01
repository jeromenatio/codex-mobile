const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");
const WebSocket = require("ws");
const {
  createDatabase,
  DEFAULT_NOTIFICATION_DURATION_SECONDS,
  DEFAULT_QUICK_PROMPTS,
  DEFAULT_THEME,
} = require("./lib/database");

loadEnvFile(process.env.CODEX_MOBILE_ENV_FILE || "/etc/codex-mobile/.env");

const PORT = Number(process.env.PORT || 4180);
const ROOT_DIR = __dirname;
const TEST_MODE = process.env.CODEX_MOBILE_TEST_MODE === "1";
const FORCE_AUTH = process.env.CODEX_MOBILE_FORCE_AUTH === "1";
const DISABLE_EXTERNAL_SYNC = TEST_MODE || process.env.CODEX_MOBILE_DISABLE_EXTERNAL_SYNC === "1";
const DATA_DIR = process.env.CODEX_MOBILE_DATA_DIR || path.join(ROOT_DIR, "data");
const STATE_FILE = process.env.CODEX_MOBILE_STATE_FILE || path.join(DATA_DIR, "state.json");
const DB_FILE = process.env.CODEX_MOBILE_DB_FILE || path.join(DATA_DIR, "codex-mobile.sqlite");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DEFAULT_WORKSPACE_ROOT = process.env.CODEX_MOBILE_DEFAULT_WORKSPACE_ROOT || "/projects";
const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
const CODEX_CONFIG_FILE = process.env.CODEX_MOBILE_CONFIG_FILE || path.join(CODEX_HOME_DIR, "config.toml");
const CODEX_MODELS_CACHE_FILE = process.env.CODEX_MOBILE_MODELS_CACHE_FILE || path.join(CODEX_HOME_DIR, "models_cache.json");
const CODEX_THREADS_DB_FILE = process.env.CODEX_MOBILE_THREADS_DB_FILE || path.join(CODEX_HOME_DIR, "state_5.sqlite");
const CODEX_MOBILE_ENV_FILE = process.env.CODEX_MOBILE_ENV_FILE || "/etc/codex-mobile/.env";
const AUTH_TOKEN = String(process.env.CODEX_MOBILE_AUTH_TOKEN || "").trim();
const AUTH_ENABLED = (FORCE_AUTH || !TEST_MODE) && Boolean(AUTH_TOKEN);
const AUTH_COOKIE_NAME = "codex_mobile_auth";
const AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const RESERVED_SECRET_KEYS = new Set(["CODEX_MOBILE_AUTH_TOKEN"]);

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
const authSessions = new Map();
const database = createDatabase(DB_FILE, DEFAULT_WORKSPACE_ROOT, STATE_FILE);
let persistedState = database.loadState();

boot().catch((error) => {
  console.error("Boot failed:", error);
  process.exit(1);
});

async function boot() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });

  persistedState.sessions = Array.isArray(persistedState.sessions) ? persistedState.sessions : [];
  persistedState.lastSessionId = persistedState.lastSessionId || null;
  persistedState.hiddenSessionIds = Array.isArray(persistedState.hiddenSessionIds) ? persistedState.hiddenSessionIds : [];
  persistedState.appConfig = normalizeAppConfig(persistedState.appConfig);
  persistedState.uiState = normalizeUiState(persistedState.uiState);
  await fsp.mkdir(getWorkspaceRoot(), { recursive: true });

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

  if (!DISABLE_EXTERNAL_SYNC) {
    syncExternalCodexSessions();
  }

  registerRoutes();
  registerWebsocket();

  server.listen(PORT, () => {
    console.log(`Codex Mobile listening on http://0.0.0.0:${PORT}`);
  });
}

function registerRoutes() {
  app.get("/api/auth/status", (req, res) => {
    res.json({
      enabled: AUTH_ENABLED,
      authenticated: isAuthenticatedRequest(req),
    });
  });

  app.post("/api/auth/login", (req, res) => {
    if (!AUTH_ENABLED) {
      return res.json({ ok: true, enabled: false, authenticated: true });
    }

    const token = String(req.body?.token || "");
    if (!isMatchingAuthToken(token)) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const sessionId = createAuthSession();
    setAuthCookie(res, sessionId);
    res.json({ ok: true, enabled: true, authenticated: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    const sessionId = parseCookies(req.headers.cookie || "")[AUTH_COOKIE_NAME];
    if (sessionId) {
      authSessions.delete(sessionId);
    }
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  app.use("/api", (req, res, next) => {
    if (req.path === "/auth/status" || req.path === "/auth/login" || req.path === "/auth/logout") {
      return next();
    }
    if (!AUTH_ENABLED || isAuthenticatedRequest(req)) {
      return next();
    }
    res.status(401).json({ error: "Authentication required" });
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json(buildBootstrap());
  });

  app.get("/api/sessions/search", (req, res) => {
    try {
      const query = String(req.query?.q || "").trim();
      if (!query) {
        return res.json({ query: "", sessions: [] });
      }

      const sessions = database
        .searchSessions(query, getWorkspaceRoot())
        .map(sanitizeSession);

      res.json({ query, sessions });
    } catch (error) {
      console.error("Failed to search sessions:", error);
      res.status(500).json({ error: error.message || "Failed to search sessions" });
    }
  });

  app.get("/api/config/codex", async (_req, res) => {
    try {
      res.json(await readCodexConfigSettings());
    } catch (error) {
      console.error("Failed to read Codex config:", error);
      res.status(500).json({ error: error.message || "Failed to read Codex config" });
    }
  });

  app.get("/api/config/app", (_req, res) => {
    res.json({
      workspaceRoot: getWorkspaceRoot(),
    });
  });

  app.get("/api/secrets", async (_req, res) => {
    try {
      res.json({ secrets: await listSecrets(CODEX_MOBILE_ENV_FILE) });
    } catch (error) {
      console.error("Failed to list secrets:", error);
      res.status(500).json({ error: error.message || "Failed to list secrets" });
    }
  });

  app.get("/api/ui-state", (_req, res) => {
    res.json({
      theme: persistedState.uiState.theme,
      notificationDurationSeconds: persistedState.uiState.notificationDurationSeconds,
      prompts: persistedState.uiState.prompts,
      lastSessionId: persistedState.lastSessionId || null,
    });
  });

  app.put("/api/config/app", async (req, res) => {
    try {
      const workspaceRoot = normalizeWorkspaceRoot(req.body?.workspaceRoot);
      await fsp.mkdir(workspaceRoot, { recursive: true });
      persistedState.appConfig = { workspaceRoot };
      const visibleSessions = persistedState.sessions.filter((session) => isSessionInWorkspaceRoot(session));
      persistedState.lastSessionId = visibleSessions.some((session) => session.id === persistedState.lastSessionId)
        ? persistedState.lastSessionId
        : visibleSessions[0]?.id || null;
      await saveState();
      res.json({ workspaceRoot, bootstrap: buildBootstrap() });
    } catch (error) {
      console.error("Failed to update app config:", error);
      res.status(500).json({ error: error.message || "Failed to update app config" });
    }
  });

  app.post("/api/secrets", async (req, res) => {
    try {
      const key = normalizeSecretKey(req.body?.key);
      const type = normalizeSecretType(req.body?.type);
      const value = String(req.body?.value || "");
      const identifier = String(req.body?.identifier || "");
      const password = String(req.body?.password || "");
      if (!key || !value) {
        if (type === "value") {
          return res.status(400).json({ error: "key and value are required" });
        }
      }
      if (!key || (type === "credentials" && (!identifier || !password))) {
        return res.status(400).json({ error: "invalid secret payload" });
      }
      if (RESERVED_SECRET_KEYS.has(key)) {
        return res.status(403).json({ error: "Reserved secret key" });
      }
      if (type === "credentials") {
        await removeEnvValue(CODEX_MOBILE_ENV_FILE, key);
        delete process.env[key];
        await upsertEnvValue(CODEX_MOBILE_ENV_FILE, `${key}_ID`, identifier);
        await upsertEnvValue(CODEX_MOBILE_ENV_FILE, `${key}_PASSWORD`, password);
        process.env[`${key}_ID`] = identifier;
        process.env[`${key}_PASSWORD`] = password;
      } else {
        await removeEnvValue(CODEX_MOBILE_ENV_FILE, `${key}_ID`);
        await removeEnvValue(CODEX_MOBILE_ENV_FILE, `${key}_PASSWORD`);
        delete process.env[`${key}_ID`];
        delete process.env[`${key}_PASSWORD`];
        await upsertEnvValue(CODEX_MOBILE_ENV_FILE, key, value);
        process.env[key] = value;
      }
      res.status(201).json({ secret: { key, type, hasValue: true } });
    } catch (error) {
      console.error("Failed to create secret:", error);
      res.status(500).json({ error: error.message || "Failed to create secret" });
    }
  });

  app.patch("/api/secrets/:key", async (req, res) => {
    try {
      const currentKey = normalizeSecretKey(req.params.key);
      const nextKey = normalizeSecretKey(req.body?.key || currentKey);
      const type = normalizeSecretType(req.body?.type);
      const nextValue = String(req.body?.value || "");
      const nextIdentifier = String(req.body?.identifier || "");
      const nextPassword = String(req.body?.password || "");
      if (!currentKey || !nextKey) {
        return res.status(400).json({ error: "invalid key" });
      }
      const editingReserved = RESERVED_SECRET_KEYS.has(currentKey);
      if (editingReserved && currentKey !== nextKey) {
        return res.status(403).json({ error: "Reserved secret key" });
      }
      if (!editingReserved && RESERVED_SECRET_KEYS.has(nextKey)) {
        return res.status(403).json({ error: "Reserved secret key" });
      }

      const envMap = await readEnvMap(CODEX_MOBILE_ENV_FILE);
      const currentSecret = resolveSecretFromEnv(envMap, currentKey);
      if (!currentSecret) {
        return res.status(404).json({ error: "Secret not found" });
      }
      const nextType = type || currentSecret.type;

      if (currentSecret.type === "credentials") {
        await removeEnvValue(CODEX_MOBILE_ENV_FILE, `${currentKey}_ID`);
        await removeEnvValue(CODEX_MOBILE_ENV_FILE, `${currentKey}_PASSWORD`);
        delete process.env[`${currentKey}_ID`];
        delete process.env[`${currentKey}_PASSWORD`];
      } else {
        await removeEnvValue(CODEX_MOBILE_ENV_FILE, currentKey);
        delete process.env[currentKey];
      }

      if (nextType === "credentials") {
        const identifier = nextIdentifier || currentSecret.identifier || "";
        const password = nextPassword || currentSecret.password || "";
        if (!identifier || !password) {
          return res.status(400).json({ error: "identifier and password are required" });
        }
        await upsertEnvValue(CODEX_MOBILE_ENV_FILE, `${nextKey}_ID`, identifier);
        await upsertEnvValue(CODEX_MOBILE_ENV_FILE, `${nextKey}_PASSWORD`, password);
        process.env[`${nextKey}_ID`] = identifier;
        process.env[`${nextKey}_PASSWORD`] = password;
      } else {
        const preservedValue = nextValue || currentSecret.value || "";
        if (!preservedValue) {
          return res.status(400).json({ error: "value is required" });
        }
        await upsertEnvValue(CODEX_MOBILE_ENV_FILE, nextKey, preservedValue);
        process.env[nextKey] = preservedValue;
      }
      res.json({ secret: { key: nextKey, type: nextType, hasValue: true } });
    } catch (error) {
      console.error("Failed to update secret:", error);
      res.status(500).json({ error: error.message || "Failed to update secret" });
    }
  });

  app.delete("/api/secrets/:key", async (req, res) => {
    try {
      const key = normalizeSecretKey(req.params.key);
      if (!key) {
        return res.status(400).json({ error: "invalid key" });
      }
      if (RESERVED_SECRET_KEYS.has(key)) {
        return res.status(403).json({ error: "Reserved secret key" });
      }
      await removeEnvValue(CODEX_MOBILE_ENV_FILE, key);
      await removeEnvValue(CODEX_MOBILE_ENV_FILE, `${key}_ID`);
      await removeEnvValue(CODEX_MOBILE_ENV_FILE, `${key}_PASSWORD`);
      delete process.env[key];
      delete process.env[`${key}_ID`];
      delete process.env[`${key}_PASSWORD`];
      res.json({ ok: true });
    } catch (error) {
      console.error("Failed to delete secret:", error);
      res.status(500).json({ error: error.message || "Failed to delete secret" });
    }
  });

  app.put("/api/ui-state", async (req, res) => {
    try {
      const nextState = {
        theme: req.body?.theme ?? persistedState.uiState.theme,
        notificationDurationSeconds:
          req.body?.notificationDurationSeconds ?? persistedState.uiState.notificationDurationSeconds,
        prompts: req.body?.prompts ?? persistedState.uiState.prompts,
      };

      if (Object.prototype.hasOwnProperty.call(req.body || {}, "lastSessionId")) {
        const incoming = String(req.body?.lastSessionId || "").trim();
        persistedState.lastSessionId = incoming || null;
      }

      persistedState.uiState = normalizeUiState(nextState);
      await saveState();
      res.json({
        theme: persistedState.uiState.theme,
        notificationDurationSeconds: persistedState.uiState.notificationDurationSeconds,
        prompts: persistedState.uiState.prompts,
        lastSessionId: persistedState.lastSessionId || null,
      });
    } catch (error) {
      console.error("Failed to update UI state:", error);
      res.status(500).json({ error: error.message || "Failed to update UI state" });
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

  app.get("/api/sessions/:sessionId/export", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      await hydrateSessionMessages(session);
      res.json({
        exportedAt: new Date().toISOString(),
        session: serializeSessionForExport(session),
      });
    } catch (error) {
      console.error("Failed to export session:", error);
      res.status(500).json({ error: error.message || "Failed to export session" });
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

      res.json({
        ok: true,
        session: sanitizeSession(session),
        messages: serializeSessionForExport(session).messages,
      });
    } catch (error) {
      console.error("Failed to send message:", error);
      res.status(500).json({ error: error.message || "Failed to send message" });
    }
  });

  app.post("/api/sessions/:sessionId/retry", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      if (runtimes.get(session.id)?.process) {
        return res.status(409).json({ error: "Codex is already processing this session" });
      }

      const sourceMessage = [...session.messages].reverse().find((message) => message.role === "user");
      if (!sourceMessage) {
        return res.status(400).json({ error: "No user message to retry" });
      }

      const attachments = Array.isArray(sourceMessage.attachments) ? sourceMessage.attachments : [];
      await appendUserMessage(session, sourceMessage.text || "", attachments);
      runSessionTurn(session, sourceMessage.text || "", attachments);

      res.json({
        ok: true,
        session: sanitizeSession(session),
        messages: serializeSessionForExport(session).messages,
      });
    } catch (error) {
      console.error("Failed to retry session:", error);
      res.status(500).json({ error: error.message || "Failed to retry session" });
    }
  });

  app.post("/api/sessions/:sessionId/interrupt", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const runtime = runtimes.get(session.id);
      if (!runtime?.process) {
        return res.status(409).json({ error: "No running turn for this session" });
      }

      runtime.interruptRequested = true;
      runtime.process.kill("SIGTERM");
      res.json({ ok: true });
    } catch (error) {
      console.error("Failed to interrupt session:", error);
      res.status(500).json({ error: error.message || "Failed to interrupt session" });
    }
  });
}

function registerWebsocket() {
  wss.on("connection", (socket, req) => {
    void handleWebsocketConnection(socket, req);
  });
}

async function handleWebsocketConnection(socket, req) {
    if (AUTH_ENABLED && !isAuthenticatedRequest(req)) {
      socket.close(1008, "Authentication required");
      return;
    }

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
    workspaceRoot: getWorkspaceRoot(),
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
  if (TEST_MODE) {
    return runFakeSessionTurn(session, prompt, attachments);
  }

  const args = buildCodexArgs(session, prompt, attachments);
  const child = spawn("codex", args, {
    cwd: session.workspacePath,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const runtime = ensureRuntimeShell(session.id);
  runtime.process = child;
  runtime.interruptRequested = false;

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
    const interrupted = Boolean(runtime.interruptRequested);
    runtime.interruptRequested = false;
    await finalizeSessionTurn(session, runtime, pendingMessage, { code, interrupted });
  });
}

function runFakeSessionTurn(session, prompt, attachments = []) {
  const runtime = ensureRuntimeShell(session.id);
  runtime.interruptRequested = false;

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
  session.threadId = session.threadId || `test-thread-${session.id}`;
  void saveState();
  broadcastToSession(session.id, {
    type: "message",
    message: pendingMessage,
    session: sanitizeSession(session),
  });

  const delay = prompt.includes("__SLOW__") ? 5000 : 120;
  const timer = setTimeout(async () => {
    runtime.process = null;
    pendingMessage.text = buildFakeAssistantResponse(session, prompt, attachments);
    await finalizeSessionTurn(session, runtime, pendingMessage, { code: 0, interrupted: false });
  }, delay);

  runtime.process = {
    kill() {
      clearTimeout(timer);
      if (!runtime.process) {
        return;
      }
      runtime.process = null;
      runtime.interruptRequested = true;
      void finalizeSessionTurn(session, runtime, pendingMessage, { code: 0, interrupted: true });
    },
  };
}

function buildFakeAssistantResponse(session, prompt, attachments = []) {
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
    return `Réponse longue pour ${session.name}\n\n${"ligne de test\n".repeat(30).trim()}`;
  }

  return `Réponse de test: ${prompt}`;
}

async function finalizeSessionTurn(session, runtime, pendingMessage, { code = 0, interrupted = false }) {
  if (!pendingMessage.text.trim()) {
    pendingMessage.text =
      interrupted
        ? "Réponse interrompue."
        : code === 0
        ? "Réponse vide."
        : `La session Codex a échoué${runtime.stderr.length ? `: ${runtime.stderr.join(" ")}` : "."}`;
  }

  pendingMessage.pending = false;
  session.status = interrupted ? "idle" : code === 0 ? "idle" : "error";
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

  if (runtime.clients.size === 0 && !runtime.process) {
    runtimes.delete(session.id);
  }
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
  const workspacePath = path.join(getWorkspaceRoot(), id);
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
    .filter((session) => isSessionInWorkspaceRoot(session))
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
    lastSessionId:
      sessions.some((session) => session.id === persistedState.lastSessionId)
        ? persistedState.lastSessionId
        : sessions[0]?.id || null,
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

function serializeSessionForExport(session) {
  return {
    id: session.id,
    name: session.name || session.workspaceName,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    workspacePath: session.workspacePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    threadId: session.threadId || null,
    messages: Array.isArray(session.messages)
      ? session.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          attachments: Array.isArray(message.attachments) ? message.attachments : [],
          pending: Boolean(message.pending),
          createdAt: message.createdAt,
        }))
      : [],
  };
}

function ensureRuntimeShell(sessionId) {
  if (!runtimes.has(sessionId)) {
    runtimes.set(sessionId, {
      clients: new Set(),
      process: null,
      stderr: [],
      interruptRequested: false,
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

function loadEnvFile(envFile) {
  try {
    const entries = readEnvEntriesSync(envFile);
    for (const [key, value] of entries) {
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.error("Failed to load env file:", error);
  }
}

function readEnvEntriesSync(envFile) {
  if (!envFile || !fs.existsSync(envFile)) {
    return [];
  }

  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    entries.push([key, value]);
  }
  return entries;
}

async function readEnvMap(envFile) {
  try {
    const entries = readEnvEntriesSync(envFile);
    return new Map(entries);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  return new Map();
}

async function listSecrets(envFile) {
  const map = await readEnvMap(envFile);
  const consumed = new Set();
  const secrets = [];

  for (const [key, value] of map.entries()) {
    if (!key || consumed.has(key)) {
      continue;
    }

    if (key.endsWith("_ID")) {
      const baseKey = key.slice(0, -3);
      const passwordKey = `${baseKey}_PASSWORD`;
      if (!RESERVED_SECRET_KEYS.has(baseKey) && map.has(passwordKey)) {
        consumed.add(key);
        consumed.add(passwordKey);
        secrets.push({
          key: baseKey,
          type: "credentials",
          hasValue: Boolean(String(value || "")) && Boolean(String(map.get(passwordKey) || "")),
          protected: RESERVED_SECRET_KEYS.has(baseKey),
          canDelete: !RESERVED_SECRET_KEYS.has(baseKey),
          canEditKey: !RESERVED_SECRET_KEYS.has(baseKey),
        });
        continue;
      }
    }

    if (key.endsWith("_PASSWORD")) {
      const baseKey = key.slice(0, -9);
      const idKey = `${baseKey}_ID`;
      if (!RESERVED_SECRET_KEYS.has(baseKey) && map.has(idKey)) {
        continue;
      }
    }

    secrets.push({
      key,
      type: "value",
      hasValue: Boolean(String(value || "")),
      protected: RESERVED_SECRET_KEYS.has(key),
      canDelete: !RESERVED_SECRET_KEYS.has(key),
      canEditKey: !RESERVED_SECRET_KEYS.has(key),
    });
  }

  return secrets.sort((a, b) => a.key.localeCompare(b.key));
}

async function upsertEnvValue(envFile, key, value) {
  const targetPath = path.resolve(envFile);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });

  let source = "";
  try {
    source = await fsp.readFile(targetPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const lines = source ? source.split(/\r?\n/) : [];
  const nextLines = [];
  let replaced = false;

  for (const line of lines) {
    if (!line.startsWith(`${key}=`)) {
      nextLines.push(line);
      continue;
    }

    if (!replaced) {
      nextLines.push(`${key}=${value}`);
      replaced = true;
    }
  }

  if (!replaced) {
    nextLines.push(`${key}=${value}`);
  }

  const serialized = `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
  await fsp.writeFile(targetPath, serialized, "utf8");
}

async function removeEnvValue(envFile, key) {
  const targetPath = path.resolve(envFile);
  let source = "";
  try {
    source = await fsp.readFile(targetPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const lines = source ? source.split(/\r?\n/) : [];
  const nextLines = lines.filter((line) => !line.startsWith(`${key}=`));
  const serialized = `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
  await fsp.writeFile(targetPath, serialized, "utf8");
}

function normalizeSecretKey(value) {
  const key = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return "";
  }
  return key;
}

function normalizeSecretType(value) {
  return String(value || "").trim() === "credentials" ? "credentials" : "value";
}

function resolveSecretFromEnv(envMap, key) {
  if (envMap.has(key)) {
    return {
      key,
      type: "value",
      value: String(envMap.get(key) || ""),
    };
  }

  const idKey = `${key}_ID`;
  const passwordKey = `${key}_PASSWORD`;
  if (envMap.has(idKey) || envMap.has(passwordKey)) {
    return {
      key,
      type: "credentials",
      identifier: String(envMap.get(idKey) || ""),
      password: String(envMap.get(passwordKey) || ""),
    };
  }

  return null;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const chunk of String(cookieHeader || "").split(";")) {
    const [rawKey, ...rest] = chunk.trim().split("=");
    if (!rawKey) {
      continue;
    }
    cookies[rawKey] = decodeURIComponent(rest.join("=") || "");
  }
  return cookies;
}

function createAuthSession() {
  const sessionId = crypto.randomUUID();
  authSessions.set(sessionId, Date.now() + AUTH_SESSION_TTL_SECONDS * 1000);
  return sessionId;
}

function setAuthCookie(res, sessionId) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_SESSION_TTL_SECONDS}`
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function isMatchingAuthToken(candidate) {
  const candidateBuffer = Buffer.from(String(candidate || ""));
  const tokenBuffer = Buffer.from(AUTH_TOKEN);
  if (!candidateBuffer.length || candidateBuffer.length !== tokenBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidateBuffer, tokenBuffer);
}

function isAuthenticatedRequest(req) {
  if (!AUTH_ENABLED) {
    return true;
  }

  cleanupExpiredAuthSessions();
  const cookies = parseCookies(req.headers.cookie || "");
  const sessionId = cookies[AUTH_COOKIE_NAME];
  if (!sessionId) {
    return false;
  }

  const expiresAt = authSessions.get(sessionId);
  if (!expiresAt || expiresAt <= Date.now()) {
    authSessions.delete(sessionId);
    return false;
  }

  authSessions.set(sessionId, Date.now() + AUTH_SESSION_TTL_SECONDS * 1000);
  return true;
}

function cleanupExpiredAuthSessions() {
  const now = Date.now();
  for (const [sessionId, expiresAt] of authSessions.entries()) {
    if (expiresAt <= now) {
      authSessions.delete(sessionId);
    }
  }
}

async function readCodexConfigSettings() {
  const text = await readCodexConfigText();
  const availableModels = await readAvailableModelsLive();
  return parseCodexConfigSettings(text, availableModels);
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
    return parseCodexConfigSettings(text, readAvailableModels());
  } catch {
    return parseCodexConfigSettings("", readAvailableModels());
  }
}

function parseCodexConfigSettings(text, availableModels = readAvailableModels()) {
  return {
    model: parseTopLevelTomlString(text, "model") || "gpt-5.4",
    availableModels,
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

  const availableModels = await readAvailableModelsLive();
  return parseCodexConfigSettings(text, availableModels);
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

async function readAvailableModelsLive() {
  if (TEST_MODE) {
    return getTestModels();
  }
  try {
    const models = await requestCodexAppServerModels();
    return models.length ? models : readAvailableModels();
  } catch (error) {
    console.error("Failed to refresh available Codex models:", error);
    return readAvailableModels();
  }
}

function getTestModels() {
  return [
    { slug: "gpt-5.4", label: "gpt-5.4", description: "Latest frontier agentic coding model." },
    { slug: "gpt-5.4-mini", label: "GPT-5.4-Mini", description: "Smaller frontier agentic coding model." },
    { slug: "gpt-5.3-codex", label: "gpt-5.3-codex", description: "Frontier Codex-optimized agentic coding model." },
    { slug: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark", description: "Ultra-fast coding model." },
  ];
}

async function requestCodexAppServerModels() {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let requestId = 0;
    const pending = new Map();

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      child.kill("SIGTERM");
      callback();
    };

    const sendRequest = (method, params) =>
      new Promise((resolveRequest, rejectRequest) => {
        requestId += 1;
        pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
      });

    const rejectPending = (error) => {
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(error);
      }
      pending.clear();
    };

    const timeoutId = setTimeout(() => {
      const error = new Error("Codex app-server model refresh timed out");
      finish(() => reject(error));
      rejectPending(error);
    }, 12000);

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      while (true) {
        const lineBreakIndex = stdoutBuffer.indexOf("\n");
        if (lineBreakIndex === -1) {
          break;
        }

        const line = stdoutBuffer.slice(0, lineBreakIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(lineBreakIndex + 1);
        if (!line) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id == null || !pending.has(message.id)) {
          continue;
        }

        const pendingRequest = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          pendingRequest.reject(new Error(message.error.message || "Codex app-server request failed"));
        } else {
          pendingRequest.resolve(message.result);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", (error) => {
      finish(() => reject(error));
      rejectPending(error);
    });

    child.on("exit", (code) => {
      if (!settled && code !== 0) {
        const error = new Error(stderrBuffer.trim() || `Codex app-server exited with code ${code}`);
        finish(() => reject(error));
        rejectPending(error);
      }
    });

    (async () => {
      try {
        await sendRequest("initialize", {
          clientInfo: {
            name: "codex-mobile",
            version: "1.0.0",
          },
          capabilities: {},
        });

        const response = await sendRequest("model/list", {
          includeHidden: false,
          limit: 200,
        });

        const models = Array.isArray(response?.data) ? response.data : [];
        finish(() =>
          resolve(
            models.map((model) => ({
              slug: String(model.model || model.id || ""),
              label: String(model.displayName || model.model || model.id || ""),
              description: String(model.description || ""),
            })).filter((model) => model.slug)
          )
        );
      } catch (error) {
        finish(() => reject(error));
        rejectPending(error);
      }
    })();
  });
}

function setNoCacheHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function syncExternalCodexSessions() {
  const threads = readCodexThreads(getWorkspaceRoot());
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
      existing.workspaceRoot = existing.workspaceRoot || getWorkspaceRoot();
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
      workspaceRoot: getWorkspaceRoot(),
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

function readCodexThreads(workspaceRoot) {
  const script = `
import json, sqlite3
from pathlib import Path

db = Path(${JSON.stringify(CODEX_THREADS_DB_FILE)})
if not db.exists():
    print("[]")
    raise SystemExit(0)

con = sqlite3.connect(str(db))
cur = con.cursor()
workspace_root = ${JSON.stringify(workspaceRoot)}
rows = cur.execute(
    "select id, cwd, title, created_at, updated_at, rollout_path from threads where archived = 0 and cwd like ? order by updated_at desc",
    (workspace_root.rstrip("/") + "/%",)
).fetchall()

items = []
for thread_id, cwd, title, created_at, updated_at, rollout_path in rows:
    prefix = workspace_root.rstrip("/") + "/"
    rel = cwd[len(prefix):]
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
con = sqlite3.connect(${JSON.stringify(CODEX_THREADS_DB_FILE)})
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
    persistedState.uiState = normalizeUiState(persistedState.uiState);
    persistedState.appConfig = normalizeAppConfig(persistedState.appConfig);
    await database.saveState(persistedState);
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

function normalizeAppConfig(config) {
  return {
    workspaceRoot: normalizeWorkspaceRoot(config?.workspaceRoot),
  };
}

function normalizeUiState(uiState) {
  const prompts = Array.isArray(uiState?.prompts)
    ? uiState.prompts
        .map((prompt) => ({
          id: String(prompt.id || crypto.randomUUID()),
          name: String(prompt.name || "").trim(),
          text: String(prompt.text || ""),
          locked: Boolean(prompt.locked),
        }))
        .filter((prompt) => prompt.name)
    : [];

  for (const item of DEFAULT_QUICK_PROMPTS) {
    const index = prompts.findIndex((prompt) => prompt.name.trim().toLowerCase() === item.name.trim().toLowerCase());
    if (index === -1) {
      prompts.push({ id: crypto.randomUUID(), ...item });
      continue;
    }
    prompts[index].locked = true;
    prompts[index].text = item.text;
  }

  return {
    theme: String(uiState?.theme || DEFAULT_THEME).trim() || DEFAULT_THEME,
    notificationDurationSeconds: clampNotificationDuration(uiState?.notificationDurationSeconds),
    prompts,
  };
}

function clampNotificationDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_NOTIFICATION_DURATION_SECONDS;
  }
  return Math.min(30, Math.max(1, Math.round(seconds)));
}

function normalizeWorkspaceRoot(value) {
  const input = String(value || "").trim();
  if (!input) {
    return DEFAULT_WORKSPACE_ROOT;
  }

  const resolved = path.resolve(input);
  return resolved || DEFAULT_WORKSPACE_ROOT;
}

function getWorkspaceRoot() {
  return normalizeWorkspaceRoot(persistedState?.appConfig?.workspaceRoot);
}

function isSessionInWorkspaceRoot(session) {
  const workspacePath = String(session?.workspacePath || "");
  const root = getWorkspaceRoot();
  return workspacePath === root || workspacePath.startsWith(`${root}${path.sep}`);
}
