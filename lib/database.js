const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_THEME = "sandstone";
const DEFAULT_NOTIFICATION_DURATION_SECONDS = 5;

const DEFAULT_QUICK_PROMPTS = [
  {
    name: "Commit & push",
    text: "Commit et push. Utilise le token GitHub se trouvant dans /etc/codex-mobile/.env. S'il n'existe pas encore de dépôt, crée-le d'abord.",
    locked: true,
  },
  {
    name: "Sécurisation serveur",
    text: "Sécurise le serveur avec UFW. Ferme toutes les connexions entrantes par défaut, autorise toutes les connexions sortantes, puis ouvre uniquement les ports SSH, HTTP et HTTPS (22, 80, 443). Il est important d'ouvrir le port SSH avant d'activer UFW pour éviter de perdre l'accès au serveur.",
    locked: true,
  },
  {
    name: "Installation Caddy",
    text: "Installe Caddy dans /etc/codex-mobile/caddy. Il sera utilisé comme reverse proxy pour gérer les redirections et les proxys vers les services locaux ou Docker. Configure-le pour gérer automatiquement les certificats TLS et leur renouvellement via Let's Encrypt.",
    locked: true,
  },
];

function createDatabase(file, defaultWorkspaceRoot, legacyStateFile = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  createSchema(db);
  seedDefaults(db, defaultWorkspaceRoot);
  migrateLegacyState(db, legacyStateFile, defaultWorkspaceRoot);

  return {
    loadState() {
      return loadState(db, defaultWorkspaceRoot);
    },
    async saveState(state) {
      saveState(db, state, defaultWorkspaceRoot);
    },
    close() {
      db.close();
    },
  };
}

async function initializeDatabaseFile(file, defaultWorkspaceRoot, legacyStateFile = "") {
  const database = createDatabase(file, defaultWorkspaceRoot, legacyStateFile);
  database.close();
  await fsp.mkdir(path.dirname(file), { recursive: true });
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ui_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      theme TEXT NOT NULL,
      notification_duration_seconds INTEGER NOT NULL,
      last_session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS quick_prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      text TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      rollout_path TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      pending INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hidden_external_sessions (
      id TEXT PRIMARY KEY
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_root ON sessions(workspace_root);
    CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace_name ON sessions(workspace_name);
    CREATE INDEX IF NOT EXISTS idx_messages_session_position ON messages(session_id, position);
  `);
}

function seedDefaults(db, defaultWorkspaceRoot) {
  const setAppConfig = db.prepare("INSERT INTO app_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING");
  setAppConfig.run("workspace_root", defaultWorkspaceRoot);

  db.prepare(`
    INSERT INTO ui_state(id, theme, notification_duration_seconds, last_session_id)
    VALUES (1, ?, ?, NULL)
    ON CONFLICT(id) DO NOTHING
  `).run(DEFAULT_THEME, DEFAULT_NOTIFICATION_DURATION_SECONDS);

  ensureDefaultPrompts(db);
}

function ensureDefaultPrompts(db) {
  const now = new Date().toISOString();
  const selectByName = db.prepare("SELECT id FROM quick_prompts WHERE lower(name) = lower(?)");
  const insert = db.prepare(`
    INSERT INTO quick_prompts(id, name, text, locked, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const lock = db.prepare("UPDATE quick_prompts SET locked = 1 WHERE id = ?");
  const maxPositionRow = db.prepare("SELECT COALESCE(MAX(position), -1) AS max_position FROM quick_prompts").get();
  let nextPosition = Number(maxPositionRow?.max_position ?? -1) + 1;

  for (const prompt of DEFAULT_QUICK_PROMPTS) {
    const existing = selectByName.get(prompt.name);
    if (!existing) {
      insert.run(crypto.randomUUID(), prompt.name, prompt.text, 1, nextPosition, now, now);
      nextPosition += 1;
      continue;
    }
    lock.run(existing.id);
  }
}

function migrateLegacyState(db, legacyStateFile, defaultWorkspaceRoot) {
  if (!legacyStateFile || !fs.existsSync(legacyStateFile)) {
    return;
  }

  const sessionCount = Number(db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count || 0);
  const hiddenCount = Number(db.prepare("SELECT COUNT(*) AS count FROM hidden_external_sessions").get().count || 0);
  const row = db.prepare("SELECT last_session_id FROM ui_state WHERE id = 1").get();
  const hasUiState = Boolean(row?.last_session_id);
  if (sessionCount > 0 || hiddenCount > 0 || hasUiState) {
    return;
  }

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyStateFile, "utf8"));
  } catch {
    return;
  }

  const sessions = Array.isArray(legacy.sessions) ? legacy.sessions : [];
  const hiddenSessionIds = Array.isArray(legacy.hiddenSessionIds) ? legacy.hiddenSessionIds : [];
  const workspaceRoot = normalizeWorkspaceRoot(legacy?.appConfig?.workspaceRoot, defaultWorkspaceRoot);
  const lastSessionId = String(legacy?.lastSessionId || "").trim() || null;

  const insertSession = db.prepare(`
    INSERT INTO sessions(
      id, name, workspace_id, workspace_name, workspace_path, workspace_root,
      created_at, updated_at, status, thread_id, rollout_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages(id, session_id, role, text, attachments_json, pending, created_at, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertHidden = db.prepare("INSERT OR IGNORE INTO hidden_external_sessions(id) VALUES (?)");
  const updateWorkspaceRoot = db.prepare("INSERT INTO app_config(key, value) VALUES ('workspace_root', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const updateUiState = db.prepare("UPDATE ui_state SET last_session_id = ? WHERE id = 1");

  runTransaction(db, () => {
    updateWorkspaceRoot.run(workspaceRoot);
    updateUiState.run(lastSessionId);

    for (const session of sessions) {
      const sessionWorkspaceRoot = normalizeWorkspaceRoot(
        path.dirname(String(session.workspacePath || workspaceRoot)),
        workspaceRoot
      );
      insertSession.run(
        String(session.id || crypto.randomUUID()),
        String(session.name || session.workspaceName || "Session"),
        String(session.workspaceId || slugify(String(session.workspaceName || session.name || "workspace")) || crypto.randomUUID()),
        String(session.workspaceName || session.name || "Workspace"),
        String(session.workspacePath || path.join(sessionWorkspaceRoot, slugify(String(session.workspaceName || session.name || "workspace")))),
        sessionWorkspaceRoot,
        String(session.createdAt || new Date().toISOString()),
        String(session.updatedAt || session.createdAt || new Date().toISOString()),
        String(session.status || "idle"),
        session.threadId ? String(session.threadId) : null,
        session.rolloutPath ? String(session.rolloutPath) : null
      );

      const messages = Array.isArray(session.messages) ? session.messages : [];
      messages.forEach((message, index) => {
        insertMessage.run(
          String(message.id || crypto.randomUUID()),
          String(session.id),
          String(message.role || "assistant"),
          String(message.text || ""),
          JSON.stringify(Array.isArray(message.attachments) ? message.attachments : []),
          message.pending ? 1 : 0,
          String(message.createdAt || new Date().toISOString()),
          index
        );
      });
    }

    for (const id of hiddenSessionIds) {
      insertHidden.run(String(id));
    }
  });
}

function loadState(db, defaultWorkspaceRoot) {
  const workspaceRoot = normalizeWorkspaceRoot(
    db.prepare("SELECT value FROM app_config WHERE key = 'workspace_root'").get()?.value,
    defaultWorkspaceRoot
  );
  const uiRow = db.prepare(`
    SELECT theme, notification_duration_seconds, last_session_id
    FROM ui_state
    WHERE id = 1
  `).get() || {};

  const prompts = db.prepare(`
    SELECT id, name, text, locked, position
    FROM quick_prompts
    ORDER BY position ASC, created_at ASC
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    text: row.text,
    locked: Boolean(row.locked),
  }));

  const messagesBySession = new Map();
  const messages = db.prepare(`
    SELECT id, session_id, role, text, attachments_json, pending, created_at, position
    FROM messages
    ORDER BY session_id ASC, position ASC
  `).all();
  for (const row of messages) {
    if (!messagesBySession.has(row.session_id)) {
      messagesBySession.set(row.session_id, []);
    }
    messagesBySession.get(row.session_id).push({
      id: row.id,
      role: row.role,
      text: row.text,
      attachments: safeJsonParse(row.attachments_json, []),
      pending: Boolean(row.pending),
      createdAt: row.created_at,
    });
  }

  const sessions = db.prepare(`
    SELECT id, name, workspace_id, workspace_name, workspace_path, workspace_root,
           created_at, updated_at, status, thread_id, rollout_path
    FROM sessions
    ORDER BY updated_at DESC
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspacePath: row.workspace_path,
    workspaceRoot: row.workspace_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    threadId: row.thread_id || null,
    rolloutPath: row.rollout_path || null,
    messages: messagesBySession.get(row.id) || [],
  }));

  const hiddenSessionIds = db.prepare("SELECT id FROM hidden_external_sessions ORDER BY id ASC").all().map((row) => row.id);

  return {
    sessions,
    lastSessionId: uiRow.last_session_id || null,
    hiddenSessionIds,
    appConfig: {
      workspaceRoot,
    },
    uiState: {
      theme: normalizeTheme(uiRow.theme),
      notificationDurationSeconds: clampDuration(uiRow.notification_duration_seconds),
      prompts: withDefaultQuickPrompts(prompts),
    },
  };
}

function saveState(db, state, defaultWorkspaceRoot) {
  const normalized = normalizeState(state, defaultWorkspaceRoot);
  const upsertWorkspaceRoot = db.prepare(`
    INSERT INTO app_config(key, value) VALUES ('workspace_root', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const upsertUiState = db.prepare(`
    INSERT INTO ui_state(id, theme, notification_duration_seconds, last_session_id)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      theme = excluded.theme,
      notification_duration_seconds = excluded.notification_duration_seconds,
      last_session_id = excluded.last_session_id
  `);
  const clearPrompts = db.prepare("DELETE FROM quick_prompts");
  const insertPrompt = db.prepare(`
    INSERT INTO quick_prompts(id, name, text, locked, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const clearMessages = db.prepare("DELETE FROM messages");
  const clearSessions = db.prepare("DELETE FROM sessions");
  const insertSession = db.prepare(`
    INSERT INTO sessions(
      id, name, workspace_id, workspace_name, workspace_path, workspace_root,
      created_at, updated_at, status, thread_id, rollout_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages(id, session_id, role, text, attachments_json, pending, created_at, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clearHidden = db.prepare("DELETE FROM hidden_external_sessions");
  const insertHidden = db.prepare("INSERT INTO hidden_external_sessions(id) VALUES (?)");

  runTransaction(db, () => {
    upsertWorkspaceRoot.run(normalized.appConfig.workspaceRoot);
    upsertUiState.run(
      normalized.uiState.theme,
      normalized.uiState.notificationDurationSeconds,
      normalized.lastSessionId
    );

    clearPrompts.run();
    normalized.uiState.prompts.forEach((prompt, index) => {
      const now = new Date().toISOString();
      insertPrompt.run(
        prompt.id || crypto.randomUUID(),
        prompt.name,
        prompt.text,
        prompt.locked ? 1 : 0,
        index,
        prompt.createdAt || now,
        now
      );
    });

    clearMessages.run();
    clearSessions.run();
    normalized.sessions.forEach((session) => {
      insertSession.run(
        session.id,
        session.name,
        session.workspaceId,
        session.workspaceName,
        session.workspacePath,
        session.workspaceRoot,
        session.createdAt,
        session.updatedAt,
        session.status,
        session.threadId || null,
        session.rolloutPath || null
      );

      session.messages.forEach((message, index) => {
        insertMessage.run(
          message.id,
          session.id,
          message.role,
          message.text,
          JSON.stringify(Array.isArray(message.attachments) ? message.attachments : []),
          message.pending ? 1 : 0,
          message.createdAt,
          index
        );
      });
    });

    clearHidden.run();
    normalized.hiddenSessionIds.forEach((id) => insertHidden.run(id));
  });
}

function normalizeState(state, defaultWorkspaceRoot) {
  const workspaceRoot = normalizeWorkspaceRoot(state?.appConfig?.workspaceRoot, defaultWorkspaceRoot);
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const uiState = state?.uiState || {};

  return {
    sessions: sessions.map((session) => ({
      id: String(session.id || crypto.randomUUID()),
      name: String(session.name || session.workspaceName || "Session"),
      workspaceId: String(session.workspaceId || slugify(String(session.workspaceName || session.name || "workspace")) || crypto.randomUUID()),
      workspaceName: String(session.workspaceName || session.name || "Workspace"),
      workspacePath: String(session.workspacePath || path.join(workspaceRoot, slugify(String(session.workspaceName || session.name || "workspace")))),
      workspaceRoot: normalizeWorkspaceRoot(session.workspaceRoot || path.dirname(String(session.workspacePath || workspaceRoot)), workspaceRoot),
      createdAt: String(session.createdAt || new Date().toISOString()),
      updatedAt: String(session.updatedAt || session.createdAt || new Date().toISOString()),
      status: String(session.status || "idle"),
      threadId: session.threadId ? String(session.threadId) : null,
      rolloutPath: session.rolloutPath ? String(session.rolloutPath) : null,
      messages: (Array.isArray(session.messages) ? session.messages : []).map((message) => ({
        id: String(message.id || crypto.randomUUID()),
        role: String(message.role || "assistant"),
        text: String(message.text || ""),
        attachments: Array.isArray(message.attachments) ? message.attachments : [],
        pending: Boolean(message.pending),
        createdAt: String(message.createdAt || new Date().toISOString()),
      })),
    })),
    lastSessionId: String(state?.lastSessionId || "").trim() || null,
    hiddenSessionIds: [...new Set((Array.isArray(state?.hiddenSessionIds) ? state.hiddenSessionIds : []).map((item) => String(item).trim()).filter(Boolean))],
    appConfig: {
      workspaceRoot,
    },
    uiState: {
      theme: normalizeTheme(uiState.theme),
      notificationDurationSeconds: clampDuration(uiState.notificationDurationSeconds),
      prompts: withDefaultQuickPrompts(Array.isArray(uiState.prompts) ? uiState.prompts : []),
    },
  };
}

function withDefaultQuickPrompts(prompts) {
  const merged = Array.isArray(prompts)
    ? prompts.map((prompt) => ({
        id: String(prompt.id || crypto.randomUUID()),
        name: String(prompt.name || "").trim(),
        text: String(prompt.text || ""),
        locked: Boolean(prompt.locked),
        createdAt: prompt.createdAt ? String(prompt.createdAt) : undefined,
      })).filter((prompt) => prompt.name)
    : [];

  for (const item of DEFAULT_QUICK_PROMPTS) {
    const index = merged.findIndex((prompt) => prompt.name.trim().toLowerCase() === item.name.trim().toLowerCase());
    if (index === -1) {
      merged.push({ id: crypto.randomUUID(), ...item });
      continue;
    }
    merged[index] = { ...merged[index], locked: true, text: item.text };
  }

  return merged;
}

function normalizeTheme(theme) {
  const input = String(theme || "").trim();
  return input || DEFAULT_THEME;
}

function clampDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_NOTIFICATION_DURATION_SECONDS;
  }
  return Math.min(30, Math.max(1, Math.round(seconds)));
}

function normalizeWorkspaceRoot(value, defaultWorkspaceRoot) {
  const input = String(value || "").trim();
  if (!input) {
    return defaultWorkspaceRoot;
  }
  const resolved = path.resolve(input);
  return resolved || defaultWorkspaceRoot;
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-");
}

function runTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

module.exports = {
  DEFAULT_NOTIFICATION_DURATION_SECONDS,
  DEFAULT_QUICK_PROMPTS,
  DEFAULT_THEME,
  createDatabase,
  initializeDatabaseFile,
};
