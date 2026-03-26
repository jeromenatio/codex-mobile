import { marked } from "/assets/marked/marked.esm.js";

const storageKey = "codex-mobile:last-session";
const settingsKey = "codex-mobile:settings";

marked.setOptions({
  breaks: true,
  gfm: true,
});

const state = {
  bootstrap: null,
  activeSessionId: null,
  socket: null,
  messages: [],
  settings: loadSettings(),
  notificationTimers: new Map(),
  pendingAttachments: [],
};

const elements = {
  openConfigModal: document.getElementById("openConfigModal"),
  closeConfigModal: document.getElementById("closeConfigModal"),
  cancelConfigModal: document.getElementById("cancelConfigModal"),
  configModal: document.getElementById("configModal"),
  configBackdrop: document.getElementById("configBackdrop"),
  configForm: document.getElementById("configForm"),
  notificationDurationInput: document.getElementById("notificationDurationInput"),
  openCreateModal: document.getElementById("openCreateModal"),
  closeCreateModal: document.getElementById("closeCreateModal"),
  cancelCreateModal: document.getElementById("cancelCreateModal"),
  closeSidebar: document.getElementById("closeSidebar"),
  createModal: document.getElementById("createModal"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  toggleSidebar: document.getElementById("toggleSidebar"),
  sidebar: document.getElementById("sidebar"),
  createSessionForm: document.getElementById("createSessionForm"),
  workspaceInput: document.getElementById("workspaceInput"),
  promptInput: document.getElementById("promptInput"),
  sessionList: document.getElementById("sessionList"),
  sessionCount: document.getElementById("sessionCount"),
  workspaceCount: document.getElementById("workspaceCount"),
  activeWorkspace: document.getElementById("activeWorkspace"),
  composerStatus: document.getElementById("composerStatus"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  imageInput: document.getElementById("imageInput"),
  pickImagesButton: document.getElementById("pickImagesButton"),
  clearComposerButton: document.getElementById("clearComposerButton"),
  messages: document.getElementById("messages"),
  sendButton: document.getElementById("sendButton"),
  notifications: document.getElementById("notifications"),
};

bootstrap();

async function bootstrap() {
  bindEvents();
  await refreshBootstrap();
  const targetSessionId = pickSessionId();
  if (targetSessionId) {
    await activateSession(targetSessionId);
  } else {
    renderSessionList();
    renderMessages();
  }
}

function bindEvents() {
  elements.openConfigModal.addEventListener("click", openConfigModal);
  elements.closeConfigModal.addEventListener("click", closeConfigModal);
  elements.cancelConfigModal.addEventListener("click", closeConfigModal);
  elements.configBackdrop.addEventListener("click", closeConfigModal);
  elements.configForm.addEventListener("submit", onSaveConfig);
  elements.openCreateModal.addEventListener("click", openCreateModal);
  elements.closeCreateModal.addEventListener("click", closeCreateModal);
  elements.cancelCreateModal.addEventListener("click", closeCreateModal);
  elements.modalBackdrop.addEventListener("click", closeCreateModal);
  elements.toggleSidebar.addEventListener("click", toggleSidebar);
  elements.closeSidebar?.addEventListener("click", closeSidebar);
  elements.createSessionForm.addEventListener("submit", onCreateSession);
  elements.messageForm.addEventListener("submit", onSendMessage);
  elements.pickImagesButton.addEventListener("click", () => elements.imageInput.click());
  elements.clearComposerButton.addEventListener("click", clearComposer);
  elements.imageInput.addEventListener("change", onPickImages);
  elements.messageInput.addEventListener("input", autoResizeMessageInput);
  elements.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.messageForm.requestSubmit();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCreateModal();
      closeConfigModal();
      closeSidebar();
    }
  });
}

async function refreshBootstrap() {
  const response = await fetch("/api/bootstrap");
  state.bootstrap = await response.json();
  renderSessionList();
}

function renderSessionList() {
  const sessions = state.bootstrap?.sessions || [];
  const workspaces = state.bootstrap?.workspaces || [];

  elements.sessionCount.textContent = `${sessions.length} session${sessions.length > 1 ? "s" : ""}`;
  elements.workspaceCount.textContent = `${workspaces.length} workspace${workspaces.length > 1 ? "s" : ""}`;

  if (!sessions.length) {
    elements.sessionList.innerHTML = `<p class="empty-state">Aucune session.</p>`;
    return;
  }

  elements.sessionList.innerHTML = sessions
    .map((session) => {
      const active = session.id === state.activeSessionId ? "active" : "";
      return `
        <article class="session-item ${active}" data-session-id="${session.id}">
          <button class="session-main" type="button" data-action="open" data-session-id="${session.id}">
            <span class="session-row">
              <strong>${escapeHtml(session.name)}</strong>
              <span class="mini-badge ${session.status === "running" ? "live" : "muted"}">${escapeHtml(session.status)}</span>
            </span>
            <span class="session-subline">${escapeHtml(session.workspaceName)} · ${escapeHtml(formatDate(session.updatedAt))}</span>
          </button>
          <div class="session-actions">
            <button class="session-action ghost-button" type="button" data-action="rename" data-session-id="${session.id}">Renommer</button>
            <button class="session-action ghost-button" type="button" data-action="delete" data-session-id="${session.id}">Supprimer</button>
          </div>
        </article>
      `;
    })
    .join("");

  for (const button of elements.sessionList.querySelectorAll("[data-action='open']")) {
    button.addEventListener("click", async () => {
      await activateSession(button.dataset.sessionId);
      closeSidebar();
    });
  }

  for (const button of elements.sessionList.querySelectorAll("[data-action='rename']")) {
    button.addEventListener("click", async () => {
      const session = state.bootstrap.sessions.find((item) => item.id === button.dataset.sessionId);
      if (!session) {
        return;
      }

      const nextName = window.prompt("Nouveau nom de session", session.name || session.workspaceName);
      if (!nextName || !nextName.trim()) {
        return;
      }

      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName.trim() }),
      });

      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      state.bootstrap = payload.bootstrap;
      renderSessionList();

      if (state.activeSessionId === session.id) {
        updateHeader(payload.session);
      }
    });
  }

  for (const button of elements.sessionList.querySelectorAll("[data-action='delete']")) {
    button.addEventListener("click", async () => {
      const sessionId = button.dataset.sessionId;
      const session = state.bootstrap.sessions.find((item) => item.id === sessionId);
      if (!session) {
        return;
      }

      const confirmed = window.confirm(`Supprimer la session "${session.name || session.workspaceName}" ?`);
      if (!confirmed) {
        return;
      }

      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        return;
      }

      const payload = await response.json();

      if (state.activeSessionId === sessionId) {
        disconnectSocket();
        state.activeSessionId = null;
        state.messages = [];
      }

      state.bootstrap = payload.bootstrap;
      const nextSessionId = pickSessionId();
      if (nextSessionId) {
        await activateSession(nextSessionId);
      } else {
        updateHeader(null);
        renderSessionList();
        renderMessages();
      }
    });
  }
}

async function activateSession(sessionId) {
  const session = state.bootstrap.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }

  disconnectSocket();
  state.activeSessionId = sessionId;
  state.messages = [];
  clearComposer();
  localStorage.setItem(storageKey, sessionId);
  updateHeader(session);
  renderSessionList();
  renderMessages();
  connectSocket(sessionId);
}

function connectSocket(sessionId) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`);
  state.socket = socket;

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "bootstrap") {
      state.messages = message.messages || [];
      updateHeader(message.session);
      renderMessages();
      return;
    }

    if (message.type === "message") {
      upsertMessage(message.message);
      updateHeader(message.session);
      renderMessages(true);
      await refreshBootstrap();
      return;
    }

    if (message.type === "message.updated") {
      upsertMessage(message.message);
      updateHeader(message.session);
      renderMessages(true);
      await refreshBootstrap();
      return;
    }

    if (message.type === "status") {
      updateHeader(message.session);
      await refreshBootstrap();
    }
  });

  socket.addEventListener("close", async () => {
    if (state.socket === socket) {
      state.socket = null;
      await refreshBootstrap();
      const session = state.bootstrap.sessions.find((item) => item.id === state.activeSessionId);
      if (session) {
        updateHeader(session);
      }
    }
  });
}

function disconnectSocket() {
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
}

async function onCreateSession(event) {
  event.preventDefault();
  const workspace = elements.workspaceInput.value.trim();
  const prompt = elements.promptInput.value.trim();
  if (!workspace) {
    return;
  }

  setBusy(true);
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace, prompt }),
  });
  setBusy(false);

  if (!response.ok) {
    notify("error", "Impossible de creer la session.");
    return;
  }

  const payload = await response.json();
  state.bootstrap = payload.bootstrap;
  elements.workspaceInput.value = "";
  elements.promptInput.value = "";
  closeCreateModal();
  notify("success", "Session créée.");
  await activateSession(payload.session.id);
}

async function onSendMessage(event) {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (!state.activeSessionId) {
    notify("warning", "Selectionne d'abord une session.");
    return;
  }
  if (!text && state.pendingAttachments.length === 0) {
    return;
  }

  const attachments = [...state.pendingAttachments];
  clearComposer();

  const response = await fetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, attachments }),
  });

  if (response.status === 409) {
    notify("info", "Codex est deja en train de repondre.");
    return;
  }
  if (!response.ok) {
    notify("error", "Envoi du message impossible.");
    return;
  }
}

function renderMessages(shouldScroll = false) {
  if (!state.messages.length) {
    elements.messages.innerHTML = `<div class="empty-chat">Démarre une session puis écris à Codex.</div>`;
    return;
  }

  elements.messages.innerHTML = state.messages
    .map((message) => {
      const pending = message.pending ? "pending" : "";
      const body = escapeHtml(message.text || (message.pending ? "Codex réfléchit..." : ""));
      return `
        <article class="bubble ${message.role} ${pending}">
          <div class="bubble-meta">${message.role === "user" ? "Vous" : "Codex"} · ${escapeHtml(formatDate(message.createdAt))}</div>
          <div class="bubble-body markdown-body">${renderMarkdown(body)}</div>
        </article>
      `;
    })
    .join("");

  if (shouldScroll || true) {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }
}

function upsertMessage(message) {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index === -1) {
    state.messages.push(message);
  } else {
    state.messages[index] = message;
  }
}

function updateHeader(session) {
  elements.activeWorkspace.textContent = session ? session.name || session.workspaceName : "";
  const status = session?.status || "idle";
  elements.messageInput.disabled = status === "running";
  elements.pickImagesButton.disabled = status === "running";
  elements.clearComposerButton.disabled = status === "running";
  elements.sendButton.disabled = status === "running";
  elements.composerStatus.textContent = buildComposerStatus(session);
  elements.composerStatus.className = `composer-status badge-status ${status === "idle" ? "idle" : "live"}`;
}

function pickSessionId() {
  const sessions = state.bootstrap?.sessions || [];
  if (!sessions.length) {
    return null;
  }

  const local = localStorage.getItem(storageKey);
  const server = state.bootstrap.lastSessionId;

  if (local && sessions.some((item) => item.id === local)) {
    return local;
  }
  if (server && sessions.some((item) => item.id === server)) {
    return server;
  }
  return sessions[0].id;
}

function setBusy(isBusy) {
  elements.workspaceInput.disabled = isBusy;
  elements.promptInput.disabled = isBusy;
  elements.messageInput.disabled = isBusy;
  elements.pickImagesButton.disabled = isBusy;
  elements.clearComposerButton.disabled = isBusy;
  elements.sendButton.disabled = isBusy;
}

function autoResizeMessageInput() {
  const input = elements.messageInput;
  input.style.height = "0px";
  const nextHeight = Math.min(input.scrollHeight, 132);
  input.style.height = `${Math.max(48, nextHeight)}px`;
  input.style.overflowY = input.scrollHeight > 132 ? "auto" : "hidden";
  document.documentElement.style.setProperty("--composer-h", `${Math.max(112, nextHeight + 70)}px`);
}

function openCreateModal() {
  closeSidebar();
  closeConfigModal();
  elements.createModal.classList.add("open");
  elements.createModal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    elements.workspaceInput.focus();
  }, 0);
}

function closeCreateModal() {
  elements.createModal.classList.remove("open");
  elements.createModal.setAttribute("aria-hidden", "true");
}

function openConfigModal() {
  closeSidebar();
  closeCreateModal();
  elements.notificationDurationInput.value = String(state.settings.notificationDurationSeconds);
  elements.configModal.classList.add("open");
  elements.configModal.setAttribute("aria-hidden", "false");
}

function closeConfigModal() {
  elements.configModal.classList.remove("open");
  elements.configModal.setAttribute("aria-hidden", "true");
}

function toggleSidebar() {
  elements.sidebar.classList.toggle("open");
}

function closeSidebar() {
  elements.sidebar.classList.remove("open");
}

function shortId(value) {
  return value.split("-")[0];
}

function formatDate(value) {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdown(value) {
  return marked.parse(String(value || ""));
}

function notify(type, text) {
  const id = crypto.randomUUID();
  const node = document.createElement("article");
  node.className = `toast ${type}`;
  node.dataset.notificationId = id;
  node.innerHTML = `
    <div class="toast-copy">
      <strong>${escapeHtml(notificationLabel(type))}</strong>
      <p>${escapeHtml(text)}</p>
    </div>
    <button class="toast-close" type="button" aria-label="Fermer">×</button>
  `;
  node.querySelector(".toast-close").addEventListener("click", () => dismissNotification(id));
  elements.notifications.append(node);
  const timer = window.setTimeout(() => dismissNotification(id), state.settings.notificationDurationSeconds * 1000);
  state.notificationTimers.set(id, timer);
}

function dismissNotification(id) {
  const timer = state.notificationTimers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    state.notificationTimers.delete(id);
  }
  const node = elements.notifications.querySelector(`[data-notification-id="${id}"]`);
  if (node) {
    node.remove();
  }
}

function notificationLabel(type) {
  if (type === "error") return "Erreur";
  if (type === "warning") return "Attention";
  if (type === "success") return "Succes";
  return "Info";
}

async function onPickImages(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) {
    return;
  }

  const images = [];
  for (const file of files) {
    images.push({
      name: file.name,
      dataUrl: await readFileAsDataUrl(file),
    });
  }

  state.pendingAttachments.push(...images);
  elements.imageInput.value = "";
  elements.composerStatus.textContent = buildComposerStatus(
    state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null
  );
  notify("success", `${images.length} image${images.length > 1 ? "s" : ""} ajoutée${images.length > 1 ? "s" : ""}.`);
}

function clearComposer() {
  elements.messageInput.value = "";
  elements.imageInput.value = "";
  state.pendingAttachments = [];
  autoResizeMessageInput();
  elements.composerStatus.textContent = buildComposerStatus(
    state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null
  );
}

function buildComposerStatus(session) {
  const sessionStatus = session?.status || "idle";
  const base = session ? sessionStatus : "Aucune session";
  if (!state.pendingAttachments.length) {
    return base;
  }
  return `${base} · ${state.pendingAttachments.length} image${state.pendingAttachments.length > 1 ? "s" : ""}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function onSaveConfig(event) {
  event.preventDefault();
  const seconds = clampDuration(elements.notificationDurationInput.value);
  state.settings.notificationDurationSeconds = seconds;
  localStorage.setItem(settingsKey, JSON.stringify(state.settings));
  closeConfigModal();
  notify("success", `Notifications reglees sur ${seconds}s.`);
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(settingsKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return { notificationDurationSeconds: clampDuration(parsed.notificationDurationSeconds) };
  } catch {
    return { notificationDurationSeconds: 5 };
  }
}

function clampDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return 5;
  }
  return Math.min(30, Math.max(1, Math.round(seconds)));
}

autoResizeMessageInput();
