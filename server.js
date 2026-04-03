const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const DatabaseSync = require("better-sqlite3");
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");
const WebSocket = require("ws");
const AdmZip = require("adm-zip");
const {
  createDatabase,
  DEFAULT_NOTIFICATION_DURATION_SECONDS,
  DEFAULT_QUICK_PROMPTS,
  DEFAULT_THEME,
} = require("./lib/database");

loadEnvFile(process.env.CODEX_MOBILE_ENV_FILE || "/etc/codex-mobile/.env");

const PORT = Number(process.env.PORT || 4180);
const JSON_BODY_LIMIT = process.env.CODEX_MOBILE_JSON_BODY_LIMIT || "60mb";
const ROOT_DIR = __dirname;
const TEST_MODE = process.env.CODEX_MOBILE_TEST_MODE === "1";
const FORCE_AUTH = process.env.CODEX_MOBILE_FORCE_AUTH === "1";
const DISABLE_EXTERNAL_SYNC = TEST_MODE || process.env.CODEX_MOBILE_DISABLE_EXTERNAL_SYNC === "1";
const DATA_DIR = process.env.CODEX_MOBILE_DATA_DIR || path.join(ROOT_DIR, "data");
const STATE_FILE = process.env.CODEX_MOBILE_STATE_FILE || path.join(DATA_DIR, "state.json");
const DB_FILE = process.env.CODEX_MOBILE_DB_FILE || path.join(DATA_DIR, "codex-mobile.sqlite");
const RUNTIME_SOCKET_FILE = process.env.CODEX_MOBILE_RUNTIME_SOCKET || path.join(DATA_DIR, "runtime.sock");
const RUNTIME_STATE_FILE = process.env.CODEX_MOBILE_RUNTIME_STATE_FILE || path.join(DATA_DIR, "runtime-state.json");
const RUNTIME_PID_FILE = process.env.CODEX_MOBILE_RUNTIME_PID_FILE || path.join(DATA_DIR, "runtime.pid");
const DEFAULT_WORKSPACE_ROOT = process.env.CODEX_MOBILE_DEFAULT_WORKSPACE_ROOT || "/projects";
const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
const CODEX_CONFIG_FILE = process.env.CODEX_MOBILE_CONFIG_FILE || path.join(CODEX_HOME_DIR, "config.toml");
const CODEX_MODELS_CACHE_FILE = process.env.CODEX_MOBILE_MODELS_CACHE_FILE || path.join(CODEX_HOME_DIR, "models_cache.json");
const CODEX_THREADS_DB_FILE = process.env.CODEX_MOBILE_THREADS_DB_FILE || path.join(CODEX_HOME_DIR, "state_5.sqlite");
const CODEX_MOBILE_ENV_FILE = process.env.CODEX_MOBILE_ENV_FILE || "/etc/codex-mobile/.env";
const SESSION_CONTEXT_FILE = process.env.CODEX_MOBILE_SESSION_CONTEXT_FILE || path.join(ROOT_DIR, "SESSION_CONTEXT.md");
const AUTH_TOKEN = String(process.env.CODEX_MOBILE_AUTH_TOKEN || "").trim();
const AUTH_ENABLED = (FORCE_AUTH || !TEST_MODE) && Boolean(AUTH_TOKEN);
const AUTH_COOKIE_NAME = "codex_mobile_auth";
const AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const RESERVED_SECRET_KEYS = new Set(["CODEX_MOBILE_AUTH_TOKEN"]);
const PDF_IMAGE_PAGE_LIMIT = 5;
const ZIP_ENTRY_LIMIT = 200;
const ZIP_TOTAL_BYTES_LIMIT = 50 * 1024 * 1024;
const TEXT_ATTACHMENT_READ_LIMIT = 60_000;
const TEXT_ATTACHMENT_TOTAL_CONTEXT_LIMIT = 12_000;
const RUNTIME_RESTART_GRACE_MS = Math.max(0, Number(process.env.CODEX_MOBILE_RUNTIME_RESTART_GRACE_MS || 2000));
const GIT_STATUS_CACHE_TTL_MS = Math.max(0, Number(process.env.CODEX_MOBILE_GIT_STATUS_CACHE_TTL_MS || 1000));

let pdfjsModulePromise = null;
const pdftoppmAvailable = commandExists("pdftoppm");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

app.use(express.json({ limit: JSON_BODY_LIMIT }));
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
const database = createDatabase(DB_FILE, DEFAULT_WORKSPACE_ROOT, STATE_FILE);
let persistedState = database.loadState();
let runtimeSyncTimer = null;
let runtimeSyncInFlight = false;
let runtimeRestartInFlight = false;
let runtimeUnavailableSince = 0;
let sessionContextCache = null;
let externalSyncTimer = null;
let externalSyncPromise = null;
const workspaceGitStatusCache = new Map();

boot().catch((error) => {
  console.error("Boot failed:", error);
  process.exit(1);
});

async function boot() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  persistedState.sessions = Array.isArray(persistedState.sessions) ? persistedState.sessions : [];
  persistedState.lastSessionId = persistedState.lastSessionId || null;
  persistedState.hiddenSessionIds = Array.isArray(persistedState.hiddenSessionIds) ? persistedState.hiddenSessionIds : [];
  persistedState.appConfig = normalizeAppConfig(persistedState.appConfig);
  persistedState.uiState = normalizeUiState(persistedState.uiState);
  await fsp.mkdir(getWorkspaceRoot(), { recursive: true });
  for (const session of persistedState.sessions) {
    session.messages = Array.isArray(session.messages) ? session.messages : [];
    session.name = typeof session.name === "string" && session.name.trim() ? session.name.trim() : session.workspaceName;
    await cleanupMissingAttachments(session);
  }

  await ensureRuntimeService();
  await syncRuntimeState({ boot: true });

  if (!DISABLE_EXTERNAL_SYNC) {
    await syncExternalCodexSessions();
  }

  runtimeSyncTimer = setInterval(() => {
    void syncRuntimeState();
  }, 250);
  if (!DISABLE_EXTERNAL_SYNC) {
    externalSyncTimer = setInterval(() => {
      void syncExternalCodexSessions();
    }, 5000);
  }

  registerRoutes();
  registerWebsocket();

  server.listen(PORT, () => {
    console.log(`Codex Mobile listening on http://0.0.0.0:${PORT}`);
  });
}

function registerRoutes() {
  app.get("/api/health", async (_req, res) => {
    const runtimeOk = await pingRuntime();
    res.json({ ok: true, runtimeOk });
  });

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

      await cleanupMissingAttachments(session);
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

  app.get("/api/sessions/:sessionId/git-status", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json({
        workspaceId: session.workspaceId,
        workspacePath: session.workspacePath,
        git: await getWorkspaceGitStatus(session.workspacePath),
      });
    } catch (error) {
      console.error("Failed to read git status:", error);
      res.status(500).json({ error: error.message || "Failed to read git status" });
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

      await interruptRuntimeRun(sessionId).catch(() => {});

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

      if (isSessionRunning(session)) {
        return res.status(409).json({ error: "Codex is already processing this session" });
      }

      const attachments = await materializeDraftAttachments(session, attachmentsInput);
      await appendUserMessage(session, text, attachments);
      void runSessionTurn(session, buildSessionTurnPrompt(session, text), attachments);

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

      if (isSessionRunning(session)) {
        return res.status(409).json({ error: "Codex is already processing this session" });
      }

      const sourceMessage = [...session.messages].reverse().find((message) => message.role === "user");
      if (!sourceMessage) {
        return res.status(400).json({ error: "No user message to retry" });
      }

      const attachments = Array.isArray(sourceMessage.attachments) ? sourceMessage.attachments : [];
      await appendUserMessage(session, sourceMessage.text || "", attachments);
      void runSessionTurn(session, buildSessionTurnPrompt(session, sourceMessage.text || ""), attachments);

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

      if (!isSessionRunning(session)) {
        return res.status(409).json({ error: "No running turn for this session" });
      }

      await interruptRuntimeRun(session.id);
      res.json({ ok: true });
    } catch (error) {
      console.error("Failed to interrupt session:", error);
      res.status(500).json({ error: error.message || "Failed to interrupt session" });
    }
  });

  app.post("/api/sessions/:sessionId/attachments", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const attachment = await persistDraftAttachment(session, req.body || {});
      if (!attachment) {
        return res.status(400).json({ error: "Invalid attachment payload" });
      }

      res.status(201).json({ attachment });
    } catch (error) {
      console.error("Failed to create attachment draft:", error);
      res.status(500).json({ error: error.message || "Failed to create attachment draft" });
    }
  });

  app.delete("/api/sessions/:sessionId/attachments/:attachmentId", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      const deleted = await deleteDraftAttachment(session, req.params.attachmentId);
      if (!deleted) {
        return res.status(404).json({ error: "Attachment draft not found" });
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("Failed to delete attachment draft:", error);
      res.status(500).json({ error: error.message || "Failed to delete attachment draft" });
    }
  });

  app.delete("/api/sessions/:sessionId/attachments", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      await clearDraftAttachments(session);
      res.json({ ok: true });
    } catch (error) {
      console.error("Failed to clear attachment drafts:", error);
      res.status(500).json({ error: error.message || "Failed to clear attachment drafts" });
    }
  });

  app.get("/api/sessions/:sessionId/messages/:messageId/attachments/:attachmentId", async (req, res) => {
    try {
      const session = findSession(req.params.sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const message = session.messages.find((item) => item.id === req.params.messageId);
      if (!message) {
        return res.status(404).json({ error: "Message not found" });
      }

      const attachment = (Array.isArray(message.attachments) ? message.attachments : []).find(
        (item) => item.id === req.params.attachmentId
      );
      if (!attachment?.path) {
        return res.status(404).json({ error: "Attachment not found" });
      }

      await fsp.access(attachment.path, fs.constants.R_OK);
      if (attachment.mimeType) {
        res.type(attachment.mimeType);
      }
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.sendFile(path.resolve(attachment.path), { dotfiles: "allow" });
    } catch (error) {
      if (error?.code === "ENOENT") {
        const session = findSession(req.params.sessionId);
        if (session) {
          await cleanupMissingAttachments(session);
        }
        return res.status(404).json({ error: "Attachment file not found" });
      }
      console.error("Failed to serve attachment:", error);
      return res.status(500).json({ error: error.message || "Failed to serve attachment" });
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

    await cleanupMissingAttachments(session);
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
      if (runtime.clients.size === 0) {
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
    runSessionTurn(session, buildSessionTurnPrompt(session, initialPrompt));
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

async function runSessionTurn(session, prompt, attachments = []) {
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
  await saveState();
  broadcastToSession(session.id, {
    type: "message",
    message: pendingMessage,
    session: sanitizeSession(session),
  });

  try {
    const run = await startRuntimeRun(session, prompt, attachments);
    if (run?.threadId && session.threadId !== run.threadId) {
      session.threadId = run.threadId;
      session.updatedAt = new Date().toISOString();
      await saveState();
      broadcastToSession(session.id, {
        type: "status",
        session: sanitizeSession(session),
      });
    }
    setTimeout(() => {
      void syncRuntimeState();
    }, 60);
  } catch (error) {
    await applyRuntimeCompletion(session, pendingMessage, {
      status: "error",
      pendingText: "",
      stderr: [error.message || "Runtime start failed"],
      code: 1,
    });
  }
}

function buildSessionTurnPrompt(session, userPrompt) {
  const prompt = String(userPrompt || "");
  if (session?.threadId) {
    return prompt;
  }

  const context = renderSessionContext(session).trim();
  if (!context) {
    return prompt;
  }

  return [
    context,
    "",
    "Demande utilisateur :",
    prompt,
  ].join("\n").trim();
}

function renderSessionContext(session) {
  const template = loadSessionContextTemplate().trim();
  if (!template) {
    return "";
  }

  return template
    .replaceAll("{{workspaceName}}", String(session?.workspaceName || ""))
    .replaceAll("{{workspacePath}}", String(session?.workspacePath || ""))
    .replaceAll("{{workspaceRoot}}", String(session?.workspaceRoot || ""))
    .replaceAll("{{sessionId}}", String(session?.id || ""));
}

function loadSessionContextTemplate() {
  if (sessionContextCache !== null) {
    return sessionContextCache;
  }

  try {
    sessionContextCache = fs.readFileSync(SESSION_CONTEXT_FILE, "utf8");
  } catch {
    sessionContextCache = "";
  }
  return sessionContextCache;
}

async function materializeDraftAttachments(session, attachmentsInput) {
  const persisted = [];

  for (const attachment of attachmentsInput) {
    const draftId = String(attachment?.draftId || attachment?.id || "").trim();
    if (!draftId) {
      continue;
    }

    const materialized = await finalizeDraftAttachment(session, draftId);
    if (materialized) {
      persisted.push(materialized);
    }
  }

  return persisted;
}

function getSessionUploadsDir(session) {
  return path.join(session.workspacePath, ".codex-mobile", "uploads", session.id);
}

function getSessionDraftsDir(session) {
  return path.join(getSessionUploadsDir(session), ".drafts");
}

async function persistDraftAttachment(session, attachmentInput) {
  const payload = normalizeAttachmentPayload(attachmentInput);
  if (!payload) {
    return null;
  }

  const dir = getSessionDraftsDir(session);
  await fsp.mkdir(dir, { recursive: true });

  const filename = `${payload.id}.${payload.extension}`;
  const filePath = path.join(dir, filename);
  await fsp.writeFile(filePath, payload.buffer);
  await fsp.writeFile(
    path.join(dir, `${payload.id}.json`),
    JSON.stringify({
      id: payload.id,
      name: payload.name,
      mimeType: payload.mimeType,
      extension: payload.extension,
    }, null, 2),
    "utf8"
  );

  return {
    id: payload.id,
    draftId: payload.id,
    name: payload.name,
    mimeType: payload.mimeType,
    path: filePath,
    relativePath: path.relative(session.workspacePath, filePath) || filename,
    isImage: payload.mimeType.startsWith("image/"),
  };
}

async function finalizeDraftAttachment(session, draftId) {
  const dir = getSessionDraftsDir(session);
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(path.join(dir, `${draftId}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const extension = String(metadata?.extension || "bin").replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || "bin";
  const filename = `${draftId}.${extension}`;
  const sourcePath = path.join(dir, filename);
  const exists = await fsp.stat(sourcePath).then(() => true).catch(() => false);
  if (!exists) {
    return null;
  }

  const finalDir = getSessionUploadsDir(session);
  await fsp.mkdir(finalDir, { recursive: true });
  const targetFilename = buildStoredAttachmentFilename(metadata?.name || filename, draftId, extension);
  const targetPath = path.join(finalDir, targetFilename);
  await fsp.rename(sourcePath, targetPath);
  await fsp.rm(path.join(dir, `${draftId}.json`), { force: true });

  const attachment = {
    id: draftId,
    draftId,
    name: String(metadata?.name || targetFilename),
    mimeType: String(metadata?.mimeType || "application/octet-stream"),
    path: targetPath,
    relativePath: path.relative(session.workspacePath, targetPath) || targetFilename,
    isImage: String(metadata?.mimeType || "").startsWith("image/"),
  };

  return enrichStoredAttachment(session, attachment);
}

async function deleteDraftAttachment(session, draftId) {
  const dir = getSessionDraftsDir(session);
  const metaPath = path.join(dir, `${draftId}.json`);
  const exists = await fsp.stat(metaPath).then(() => true).catch(() => false);
  await fsp.rm(metaPath, { force: true });
  const entries = await fsp.readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (entry.startsWith(`${draftId}.`) && entry !== `${draftId}.json`) {
      await fsp.rm(path.join(dir, entry), { force: true });
    }
  }
  return exists || entries.some((entry) => entry.startsWith(`${draftId}.`));
}

async function clearDraftAttachments(session) {
  await fsp.rm(getSessionDraftsDir(session), { recursive: true, force: true });
}

async function enrichStoredAttachment(session, attachment) {
  if (isPdfAttachment(attachment)) {
    return enrichPdfAttachment(session, attachment);
  }
  if (isZipAttachment(attachment)) {
    return enrichZipAttachment(session, attachment);
  }
  return attachment;
}

function isPdfAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || "").toLowerCase();
  const name = String(attachment?.name || "").toLowerCase();
  return mimeType === "application/pdf" || name.endsWith(".pdf");
}

function isZipAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || "").toLowerCase();
  const name = String(attachment?.name || "").toLowerCase();
  return mimeType.includes("zip") || name.endsWith(".zip");
}

async function enrichPdfAttachment(session, attachment) {
  const enriched = {
    ...attachment,
    pageCount: 0,
    extractedText: "",
    extractedTextPath: "",
    extractedImages: [],
    extractionError: "",
  };

  try {
    const pdfData = new Uint8Array(await fsp.readFile(attachment.path));
    const pdfjs = await loadPdfjs();
    const loadingTask = pdfjs.getDocument({
      data: pdfData,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;

    enriched.pageCount = Number(pdf.numPages) || 0;
    const pageTexts = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => String(item?.str || "").trim())
        .filter(Boolean)
        .join(" ");
      if (pageText) {
        pageTexts.push(`Page ${pageNumber}\n${pageText}`);
      }
    }

    const extractedText = pageTexts.join("\n\n").trim();
    if (extractedText) {
      const extractedTextPath = await writePdfExtractedText(session, attachment, extractedText);
      enriched.extractedText = extractedText;
      enriched.extractedTextPath = path.relative(session.workspacePath, extractedTextPath) || extractedTextPath;
    }

    if (pdftoppmAvailable) {
      enriched.extractedImages = await renderPdfPageImages(session, attachment, Math.min(pdf.numPages, PDF_IMAGE_PAGE_LIMIT));
    }

    try {
      await loadingTask.destroy();
    } catch {}
  } catch (error) {
    enriched.extractionError = error.message || "PDF extraction failed";
  }

  return enriched;
}

async function enrichZipAttachment(session, attachment) {
  const enriched = {
    ...attachment,
    extractedDirPath: "",
    extractedEntries: [],
    archiveEntryCount: 0,
    extractionError: "",
  };

  try {
    const zip = new AdmZip(attachment.path);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    enriched.archiveEntryCount = entries.length;
    if (entries.length > ZIP_ENTRY_LIMIT) {
      throw new Error(`Archive trop volumineuse (${entries.length} fichiers)`);
    }

    const totalBytes = entries.reduce((sum, entry) => sum + Number(entry.header?.size || entry.getData().length || 0), 0);
    if (totalBytes > ZIP_TOTAL_BYTES_LIMIT) {
      throw new Error("Archive trop volumineuse");
    }

    const parsed = path.parse(attachment.path);
    const outputDir = path.join(parsed.dir, `${parsed.base}.extracted`);
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.mkdir(outputDir, { recursive: true });

    const extractedEntries = [];
    for (const entry of entries) {
      const relativeEntryPath = sanitizeArchiveEntryPath(entry.entryName);
      if (!relativeEntryPath) {
        continue;
      }
      const targetPath = path.join(outputDir, relativeEntryPath);
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      const entryBuffer = entry.getData();
      await fsp.writeFile(targetPath, entryBuffer);

      const baseEntry = {
        name: path.basename(relativeEntryPath),
        mimeType: inferMimeTypeFromName(relativeEntryPath),
        path: targetPath,
        relativePath: path.relative(session.workspacePath, targetPath) || targetPath,
        isImage: isImageFilename(relativeEntryPath),
        size: entryBuffer.length,
      };

      let enrichedEntry = baseEntry;
      if (isPdfAttachment(baseEntry)) {
        enrichedEntry = await enrichPdfAttachment(session, baseEntry);
      } else if (isTextLikeAttachment(baseEntry)) {
        const extractedText = await readTextAttachment(targetPath);
        if (extractedText) {
          enrichedEntry = { ...baseEntry, extractedText };
        }
      }

      extractedEntries.push(enrichedEntry);
    }

    enriched.extractedDirPath = path.relative(session.workspacePath, outputDir) || outputDir;
    enriched.extractedEntries = extractedEntries;
  } catch (error) {
    enriched.extractionError = error.message || "ZIP extraction failed";
  }

  return enriched;
}

async function writePdfExtractedText(session, attachment, text) {
  const parsed = path.parse(attachment.path);
  const outputPath = path.join(parsed.dir, `${parsed.name}.extracted.txt`);
  await fsp.writeFile(outputPath, text, "utf8");
  return outputPath;
}

async function renderPdfPageImages(session, attachment, pageLimit) {
  if (!pageLimit || !pdftoppmAvailable) {
    return [];
  }

  const parsed = path.parse(attachment.path);
  const outputDir = path.join(parsed.dir, `${parsed.name}.pages`);
  await fsp.mkdir(outputDir, { recursive: true });
  const outputPrefix = path.join(outputDir, "page");

  await runCommand("pdftoppm", [
    "-png",
    "-f",
    "1",
    "-l",
    String(pageLimit),
    attachment.path,
    outputPrefix,
  ]);

  const files = (await fsp.readdir(outputDir))
    .filter((name) => /^page-\d+\.png$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  return files.map((filename, index) => {
    const filePath = path.join(outputDir, filename);
    return {
      name: filename,
      mimeType: "image/png",
      path: filePath,
      relativePath: path.relative(session.workspacePath, filePath) || filePath,
      isImage: true,
      page: index + 1,
    };
  });
}

function sanitizeArchiveEntryPath(entryPath) {
  const normalized = path.posix.normalize(String(entryPath || "")).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!normalized || normalized.startsWith("..")) {
    return "";
  }
  return normalized.split("/").filter(Boolean).join(path.sep);
}

function inferMimeTypeFromName(name) {
  const lowerName = String(name || "").toLowerCase();
  if (lowerName.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (/\.(png)$/i.test(lowerName)) {
    return "image/png";
  }
  if (/\.(jpe?g)$/i.test(lowerName)) {
    return "image/jpeg";
  }
  if (/\.(gif)$/i.test(lowerName)) {
    return "image/gif";
  }
  if (/\.(webp)$/i.test(lowerName)) {
    return "image/webp";
  }
  if (/\.(svg)$/i.test(lowerName)) {
    return "image/svg+xml";
  }
  if (/\.(txt|md|csv|log)$/i.test(lowerName)) {
    return "text/plain";
  }
  if (/\.(json)$/i.test(lowerName)) {
    return "application/json";
  }
  if (/\.(ya?ml)$/i.test(lowerName)) {
    return "text/yaml";
  }
  if (/\.(xml)$/i.test(lowerName)) {
    return "application/xml";
  }
  if (/\.(js|mjs|cjs|ts|tsx|jsx|py|rb|php|java|c|cc|cpp|h|hpp|cs|go|rs|sh|bash|zsh|html|css|sql)$/i.test(lowerName)) {
    return "text/plain";
  }
  if (lowerName.endsWith(".zip")) {
    return "application/zip";
  }
  return "application/octet-stream";
}

function isImageFilename(name) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(String(name || ""));
}

function isTextLikeAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || "").toLowerCase();
  const name = String(attachment?.name || "").toLowerCase();
  return mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType === "application/xml"
    || mimeType === "text/yaml"
    || /\.(txt|md|csv|log|json|ya?ml|xml|js|mjs|cjs|ts|tsx|jsx|py|rb|php|java|c|cc|cpp|h|hpp|cs|go|rs|sh|bash|zsh|html|css|sql)$/i.test(name);
}

async function readTextAttachment(filePath) {
  const buffer = await fsp.readFile(filePath);
  if (!buffer.length) {
    return "";
  }
  return buffer.toString("utf8").slice(0, TEXT_ATTACHMENT_READ_LIMIT).trim();
}

async function loadPdfjs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsModulePromise;
}

function commandExists(name) {
  const result = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(name)} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        code: Number.isInteger(code) ? code : 1,
        stdout,
        stderr,
      });
    });
  });
}

function resolveAttachmentExtension(name, mimeType) {
  const extFromName = path.extname(name || "").replace(/^\./, "").trim();
  if (extFromName) {
    return extFromName.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || "bin";
  }

  const extFromMime = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
  return extFromMime || "bin";
}

function normalizeAttachmentPayload(input) {
  const id = String(input?.id || crypto.randomUUID()).trim() || crypto.randomUUID();
  const name = String(input?.name || "attachment").trim() || "attachment";
  const dataUrl = String(input?.dataUrl || "");
  const declaredMimeType = String(input?.mimeType || "").trim();
  const match = dataUrl.match(/^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  const [, mimeType, base64] = match;
  const normalizedMimeType = declaredMimeType || mimeType || "application/octet-stream";
  const extension = resolveAttachmentExtension(name, normalizedMimeType);
  const safeName = name.replace(/[^\w.\- ]+/g, "_");
  const filename = `${id}.${extension}`;

  return {
    id,
    name: safeName,
    mimeType: normalizedMimeType,
    extension,
    filename,
    buffer: Buffer.from(base64, "base64"),
  };
}

function buildStoredAttachmentFilename(name, draftId, extension) {
  const basename = path.basename(String(name || "attachment"), path.extname(String(name || "")));
  const safeBase = basename.replace(/[^\w\- ]+/g, "_").trim() || "attachment";
  return `${safeBase}-${draftId}.${extension}`;
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
    status: session.status,
    threadId: session.threadId || null,
    messageCount: session.messages.length,
  };
}

async function getWorkspaceGitStatus(workspacePath) {
  const key = String(workspacePath || "");
  const now = Date.now();
  const cached = workspaceGitStatusCache.get(key);
  if (cached && now - cached.timestamp < GIT_STATUS_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await computeWorkspaceGitStatus(workspacePath);
  workspaceGitStatusCache.set(key, { timestamp: now, value });
  return value;
}

async function computeWorkspaceGitStatus(workspacePath) {
  const cwd = String(workspacePath || "").trim();
  if (!cwd) {
    return buildGitIndicatorState("down", "GitHub non configuré", "Aucun workspace actif.");
  }

  const insideWorkTree = await runCommandCapture("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (insideWorkTree.code !== 0 || !/^true\s*$/i.test(insideWorkTree.stdout)) {
    return buildGitIndicatorState("down", "GitHub non configuré", "Ce workspace n'est pas un dépôt Git.");
  }

  const remotes = await runCommandCapture("git", ["remote", "-v"], { cwd });
  const remoteLines = remotes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const githubRemote = remoteLines.find((line) => /github\.com/i.test(line));
  if (!githubRemote) {
    return buildGitIndicatorState("down", "GitHub non configuré", "Aucun remote GitHub détecté pour ce workspace.");
  }

  const status = await runCommandCapture("git", ["status", "--porcelain=2", "--branch"], { cwd });
  if (status.code !== 0) {
    return buildGitIndicatorState("down", "GitHub non configuré", "Impossible de lire l'état Git du workspace.");
  }

  let hasChanges = false;
  let hasUpstream = false;
  let branchHead = "";
  let ahead = 0;
  let behind = 0;

  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    if (!line.startsWith("#")) {
      hasChanges = true;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      branchHead = line.slice("# branch.head ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+\-(\d+)/);
      if (match) {
        ahead = Number(match[1] || 0);
        behind = Number(match[2] || 0);
      }
    }
  }

  if (!branchHead || branchHead === "(detached)") {
    return buildGitIndicatorState("warn", "Git à finaliser", "La branche courante n'est pas prête pour un push propre.");
  }
  if (!hasUpstream) {
    return buildGitIndicatorState("warn", "Push manquant", "La branche courante n'a pas encore d'upstream distant.");
  }
  if (hasChanges) {
    return buildGitIndicatorState("warn", "Changements non commit", "Des fichiers du workspace ne sont pas encore commités.");
  }
  if (ahead > 0 || behind > 0) {
    return buildGitIndicatorState(
      "warn",
      "Synchronisation Git requise",
      `Le workspace n'est pas totalement synchronisé (ahead ${ahead}, behind ${behind}).`
    );
  }

  return buildGitIndicatorState("ok", "GitHub à jour", "Tous les changements du workspace sont commités et poussés.");
}

function buildGitIndicatorState(level, shortLabel, detail) {
  return {
    level,
    shortLabel,
    detail,
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

function getPendingAssistantMessage(session) {
  return [...session.messages].reverse().find((message) => message.role === "assistant" && message.pending) || null;
}

function isSessionRunning(session) {
  return session?.status === "running" || Boolean(getPendingAssistantMessage(session));
}

async function ensureRuntimeService() {
  if (await pingRuntime()) {
    return;
  }

  await fsp.rm(RUNTIME_SOCKET_FILE, { force: true }).catch(() => {});
  const child = spawn(process.execPath, [path.join(ROOT_DIR, "runtime.js")], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_MOBILE_RUNTIME_SOCKET: RUNTIME_SOCKET_FILE,
      CODEX_MOBILE_RUNTIME_STATE_FILE: RUNTIME_STATE_FILE,
      CODEX_MOBILE_RUNTIME_PID_FILE: RUNTIME_PID_FILE,
      CODEX_MOBILE_DATA_DIR: DATA_DIR,
      CODEX_MOBILE_CONFIG_FILE: CODEX_CONFIG_FILE,
      CODEX_HOME: CODEX_HOME_DIR,
      CODEX_MOBILE_TEST_MODE: TEST_MODE ? "1" : process.env.CODEX_MOBILE_TEST_MODE || "0",
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await pingRuntime()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error("Runtime service unavailable");
}

async function pingRuntime() {
  try {
    const response = await runtimeRequest("GET", "/health");
    return response.statusCode === 200;
  } catch {
    return false;
  }
}

async function listRuntimeRuns() {
  const response = await runtimeRequest("GET", "/runs");
  if (response.statusCode !== 200) {
    throw new Error(response.body?.error || "Runtime list failed");
  }
  return Array.isArray(response.body?.runs) ? response.body.runs : [];
}

async function startRuntimeRun(session, prompt, attachments) {
  const response = await runtimeRequest("POST", "/runs/start", {
    sessionId: session.id,
    workspacePath: session.workspacePath,
    threadId: session.threadId || null,
    prompt,
    attachments,
  });
  if (response.statusCode !== 200) {
    throw new Error(response.body?.error || "Runtime start failed");
  }
  return response.body?.run || null;
}

async function interruptRuntimeRun(sessionId) {
  const response = await runtimeRequest("POST", `/runs/${encodeURIComponent(sessionId)}/interrupt`);
  if (response.statusCode !== 200) {
    throw new Error(response.body?.error || "Runtime interrupt failed");
  }
}

async function ackRuntimeRun(sessionId) {
  await runtimeRequest("POST", `/runs/${encodeURIComponent(sessionId)}/ack`);
}

async function runtimeRequest(method, requestPath, payload) {
  const body = payload == null ? null : Buffer.from(JSON.stringify(payload));
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: RUNTIME_SOCKET_FILE,
        path: requestPath,
        method,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(body.length),
            }
          : undefined,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ statusCode: response.statusCode || 500, body: parsed });
        });
      }
    );

    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

async function syncRuntimeState({ boot = false } = {}) {
  if (runtimeSyncInFlight) {
    return;
  }
  runtimeSyncInFlight = true;
  try {
    const runs = await listRuntimeRuns();
    runtimeUnavailableSince = 0;
    const runMap = new Map(runs.map((run) => [run.sessionId, run]));
    let changed = false;

    for (const session of persistedState.sessions) {
      const pendingMessage = getPendingAssistantMessage(session);
      const run = runMap.get(session.id);

      if (run) {
        if (run.threadId && session.threadId !== run.threadId) {
          session.threadId = run.threadId;
          session.updatedAt = new Date().toISOString();
          changed = true;
        }

        if (run.status === "running") {
          if (session.status !== "running") {
            session.status = "running";
            session.updatedAt = new Date().toISOString();
            changed = true;
            broadcastToSession(session.id, {
              type: "status",
              session: sanitizeSession(session),
            });
          }

          if (pendingMessage && run.pendingText && pendingMessage.text !== run.pendingText) {
            pendingMessage.text = run.pendingText;
            session.updatedAt = new Date().toISOString();
            changed = true;
            broadcastToSession(session.id, {
              type: "message.updated",
              message: pendingMessage,
              session: sanitizeSession(session),
            });
          }
          continue;
        }

        if (pendingMessage) {
          await applyRuntimeCompletion(session, pendingMessage, run);
          changed = true;
        }

        await ackRuntimeRun(session.id).catch(() => {});
        continue;
      }

      if (boot && pendingMessage && session.status === "running") {
        pendingMessage.pending = false;
        pendingMessage.text = pendingMessage.text?.trim() || "Réponse interrompue après rechargement du serveur.";
        session.status = "interrupted";
        session.updatedAt = new Date().toISOString();
        changed = true;
      }
    }

    const knownSessionIds = new Set(persistedState.sessions.map((session) => session.id));
    for (const run of runs) {
      if (knownSessionIds.has(run.sessionId)) {
        continue;
      }
      if (run.status !== "running") {
        await ackRuntimeRun(run.sessionId).catch(() => {});
      }
    }

    if (changed) {
      await saveState();
    }
  } catch (error) {
    console.error("Runtime sync failed:", error);
    await handleRuntimeUnavailable();
  } finally {
    runtimeSyncInFlight = false;
  }
}

async function handleRuntimeUnavailable() {
  if (!hasRunningSessions()) {
    runtimeUnavailableSince = 0;
    return;
  }
  if (!runtimeUnavailableSince) {
    runtimeUnavailableSince = Date.now();
    return;
  }
  if (runtimeRestartInFlight) {
    return;
  }
  if (Date.now() - runtimeUnavailableSince < RUNTIME_RESTART_GRACE_MS) {
    return;
  }
  runtimeRestartInFlight = true;
  try {
    await ensureRuntimeService();
  } catch (error) {
    console.error("Runtime restart attempt failed:", error);
  } finally {
    runtimeRestartInFlight = false;
  }
}

async function applyRuntimeCompletion(session, pendingMessage, run) {
  if (!pendingMessage.text.trim()) {
    pendingMessage.text =
      String(run.pendingText || "").trim() ||
      (run.status === "interrupted"
        ? "Réponse interrompue."
        : run.code === 0 || run.status === "completed"
        ? "Réponse vide."
        : `La session Codex a échoué${Array.isArray(run.stderr) && run.stderr.length ? `: ${run.stderr.join(" ")}` : "."}`);
  } else if (String(run.pendingText || "").trim()) {
    pendingMessage.text = run.pendingText;
  }

  pendingMessage.pending = false;
  session.status = run.status === "completed" || run.status === "interrupted" ? "idle" : "error";
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
}

function hasRunningSessions() {
  return persistedState.sessions.some((session) => isSessionRunning(session));
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
  const expiresAt = Date.now() + AUTH_SESSION_TTL_SECONDS * 1000;
  const payload = `${sessionId}.${expiresAt}`;
  const signature = signAuthPayload(payload);
  return `${payload}.${signature}`;
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

  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) {
    return false;
  }
  return verifyAuthSession(token);
}

function signAuthPayload(payload) {
  return crypto.createHmac("sha256", AUTH_TOKEN).update(payload).digest("hex");
}

function verifyAuthSession(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [sessionId, expiresAtRaw, signature] = parts;
  if (!sessionId || !expiresAtRaw || !signature) {
    return false;
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return false;
  }

  const payload = `${sessionId}.${expiresAtRaw}`;
  const expected = signAuthPayload(payload);
  const candidateBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
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

async function syncExternalCodexSessions() {
  if (DISABLE_EXTERNAL_SYNC) {
    return;
  }
  if (externalSyncPromise) {
    return externalSyncPromise;
  }

  const currentSync = Promise.resolve().then(async () => {
    const threads = readCodexThreads(getWorkspaceRoot());
    if (!threads.length) {
      return;
    }

    const hiddenIds = new Set(persistedState.hiddenSessionIds || []);
    let changed = false;

    for (const thread of threads) {
      if (hiddenIds.has(thread.threadId)) {
        continue;
      }

      const existing = persistedState.sessions.find(
        (session) => session.threadId === thread.threadId || session.id === thread.threadId
      );

      if (existing) {
        const previousSignature = JSON.stringify({
          workspaceId: existing.workspaceId,
          workspaceName: existing.workspaceName,
          workspacePath: existing.workspacePath,
          workspaceRoot: existing.workspaceRoot,
          name: existing.name,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          threadId: existing.threadId,
          rolloutPath: existing.rolloutPath,
        });
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
        const nextSignature = JSON.stringify({
          workspaceId: existing.workspaceId,
          workspaceName: existing.workspaceName,
          workspacePath: existing.workspacePath,
          workspaceRoot: existing.workspaceRoot,
          name: existing.name,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          threadId: existing.threadId,
          rolloutPath: existing.rolloutPath,
        });
        if (previousSignature !== nextSignature) {
          changed = true;
        }
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
      changed = true;
    }

    if (changed) {
      await saveState();
    }
  });

  externalSyncPromise = currentSync;
  try {
    await currentSync;
  } finally {
    externalSyncPromise = null;
  }
}

function readCodexThreads(workspaceRoot) {
  if (!fs.existsSync(CODEX_THREADS_DB_FILE)) {
    return [];
  }

  let db;
  try {
    db = new DatabaseSync(CODEX_THREADS_DB_FILE, { readonly: true, fileMustExist: true });
    const prefix = `${workspaceRoot.replace(/\/+$/, "")}/`;
    const rows = db.prepare(`
      SELECT id, cwd, title, created_at, updated_at, rollout_path
      FROM threads
      WHERE archived = 0 AND cwd LIKE ?
      ORDER BY updated_at DESC
    `).all(`${prefix}%`);
    return rows.map((row) => {
      const relative = String(row.cwd || "").startsWith(prefix) ? String(row.cwd).slice(prefix.length) : "";
      const workspace = relative.split(path.sep)[0] || relative.split("/")[0] || "";
      if (!workspace) {
        return null;
      }
      return {
        threadId: row.id,
        workspaceId: workspace,
        workspaceName: workspace,
        workspacePath: row.cwd,
        name: row.title || workspace,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        rolloutPath: row.rollout_path,
      };
    }).filter(Boolean);
  } catch (error) {
    console.error("Failed to read external Codex threads:", error);
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function isImportedExternalSession(session) {
  return Boolean(session?.threadId) && session.id === session.threadId;
}

function areMessagesEquivalent(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((message, index) => {
    const other = right[index];
    return other
      && message.role === other.role
      && message.text === other.text
      && Boolean(message.pending) === Boolean(other.pending)
      && message.createdAt === other.createdAt;
  });
}

async function hydrateSessionMessages(session) {
  if (!session?.threadId) {
    return;
  }

  if (Array.isArray(session.messages) && session.messages.length > 0 && !isImportedExternalSession(session)) {
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

  if (areMessagesEquivalent(session.messages, messages)) {
    return;
  }

  session.messages = messages;
  await saveState();
}

async function cleanupMissingAttachments(session) {
  if (!session || !Array.isArray(session.messages) || session.messages.length === 0) {
    return false;
  }

  let changed = false;
  for (const message of session.messages) {
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
      continue;
    }
    const sanitized = await sanitizeAttachmentsTree(message.attachments);
    if (!areAttachmentsEquivalent(message.attachments, sanitized)) {
      message.attachments = sanitized;
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  session.updatedAt = new Date().toISOString();
  await saveState();
  return true;
}

async function sanitizeAttachmentsTree(attachments) {
  const sanitized = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const next = await sanitizeSingleAttachment(attachment);
    if (next) {
      sanitized.push(next);
    }
  }
  return sanitized;
}

async function sanitizeSingleAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  if (attachment.path) {
    const exists = await fsp.access(attachment.path, fs.constants.R_OK).then(() => true).catch(() => false);
    if (!exists) {
      return null;
    }
  }

  const next = { ...attachment };
  if (Array.isArray(attachment.extractedImages)) {
    next.extractedImages = await sanitizeAttachmentsTree(attachment.extractedImages);
  }
  if (Array.isArray(attachment.extractedEntries)) {
    next.extractedEntries = await sanitizeAttachmentsTree(attachment.extractedEntries);
  }
  return next;
}

function areAttachmentsEquivalent(left, right) {
  return JSON.stringify(Array.isArray(left) ? left : []) === JSON.stringify(Array.isArray(right) ? right : []);
}

function lookupRolloutPath(threadId) {
  if (!fs.existsSync(CODEX_THREADS_DB_FILE)) {
    return "";
  }

  let db;
  try {
    db = new DatabaseSync(CODEX_THREADS_DB_FILE, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId);
    return String(row?.rollout_path || "").trim();
  } catch {
    return "";
  } finally {
    try {
      db?.close();
    } catch {}
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


let savePromise = Promise.resolve();
function saveState() {
  const currentSave = savePromise
    .catch(() => {})
    .then(async () => {
      persistedState.uiState = normalizeUiState(persistedState.uiState);
      persistedState.appConfig = normalizeAppConfig(persistedState.appConfig);
      await database.saveState(persistedState);
    });
  savePromise = currentSave.catch(() => {});
  return currentSave;
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
