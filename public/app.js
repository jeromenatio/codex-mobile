import { marked } from "/assets/marked/marked.esm.js";

const storageKey = "codex-mobile:last-session";
const settingsKey = "codex-mobile:settings";
const themes = ["sandstone", "ivory-forest", "ocean-paper", "ember-night", "rose-studio"];

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
  codexConfig: {
    model: "gpt-5.4",
    availableModels: [],
    sandboxDangerFullAccess: false,
    approvalNever: false,
    hideFullAccessWarning: false,
    search: false,
  },
  notificationTimers: new Map(),
  pendingAttachments: [],
  imagePickerBusy: false,
  pendingRenameSessionId: null,
  pendingDeleteSessionId: null,
  pendingModelSlug: null,
};

const elements = {
  openModelModal: document.getElementById("openModelModal"),
  activeModelLabel: document.getElementById("activeModelLabel"),
  openConfigModal: document.getElementById("openConfigModal"),
  scrollTopButton: document.getElementById("scrollTopButton"),
  scrollBottomButton: document.getElementById("scrollBottomButton"),
  closeConfigModal: document.getElementById("closeConfigModal"),
  cancelConfigModal: document.getElementById("cancelConfigModal"),
  configModal: document.getElementById("configModal"),
  configBackdrop: document.getElementById("configBackdrop"),
  configForm: document.getElementById("configForm"),
  themeSelect: document.getElementById("themeSelect"),
  notificationDurationInput: document.getElementById("notificationDurationInput"),
  sandboxDangerInput: document.getElementById("sandboxDangerInput"),
  approvalNeverInput: document.getElementById("approvalNeverInput"),
  hideFullAccessWarningInput: document.getElementById("hideFullAccessWarningInput"),
  searchInput: document.getElementById("searchInput"),
  imageModal: document.getElementById("imageModal"),
  imageBackdrop: document.getElementById("imageBackdrop"),
  closeImageModal: document.getElementById("closeImageModal"),
  doneImageModalButton: document.getElementById("doneImageModalButton"),
  addMoreImagesButton: document.getElementById("addMoreImagesButton"),
  clearImagesButton: document.getElementById("clearImagesButton"),
  imageManagerList: document.getElementById("imageManagerList"),
  modelModal: document.getElementById("modelModal"),
  modelBackdrop: document.getElementById("modelBackdrop"),
  closeModelModal: document.getElementById("closeModelModal"),
  modelList: document.getElementById("modelList"),
  confirmModelModal: document.getElementById("confirmModelModal"),
  confirmModelBackdrop: document.getElementById("confirmModelBackdrop"),
  closeConfirmModelModal: document.getElementById("closeConfirmModelModal"),
  cancelConfirmModelModal: document.getElementById("cancelConfirmModelModal"),
  confirmModelChangeButton: document.getElementById("confirmModelChangeButton"),
  confirmModelText: document.getElementById("confirmModelText"),
  renameModal: document.getElementById("renameModal"),
  renameBackdrop: document.getElementById("renameBackdrop"),
  closeRenameModal: document.getElementById("closeRenameModal"),
  cancelRenameModal: document.getElementById("cancelRenameModal"),
  renameSessionForm: document.getElementById("renameSessionForm"),
  renameSessionInput: document.getElementById("renameSessionInput"),
  deleteModal: document.getElementById("deleteModal"),
  deleteBackdrop: document.getElementById("deleteBackdrop"),
  closeDeleteModal: document.getElementById("closeDeleteModal"),
  cancelDeleteModal: document.getElementById("cancelDeleteModal"),
  confirmDeleteButton: document.getElementById("confirmDeleteButton"),
  deleteModalText: document.getElementById("deleteModalText"),
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
  activeMessageCount: document.getElementById("activeMessageCount"),
  activeWorkspace: document.getElementById("activeWorkspace"),
  activeSessionName: document.getElementById("activeSessionName"),
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
  applyTheme(state.settings.theme);
  try {
    await refreshCodexConfig();
  } catch (error) {
    console.warn("Codex config bootstrap failed:", error);
  }
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
  elements.openModelModal.addEventListener("click", openModelModal);
  elements.closeImageModal.addEventListener("click", closeImageModal);
  elements.doneImageModalButton.addEventListener("click", closeImageModal);
  elements.addMoreImagesButton.addEventListener("click", () => elements.imageInput.click());
  elements.clearImagesButton.addEventListener("click", clearPendingImages);
  elements.imageBackdrop.addEventListener("click", closeImageModal);
  elements.closeModelModal.addEventListener("click", closeModelModal);
  elements.modelBackdrop.addEventListener("click", closeModelModal);
  elements.closeConfirmModelModal.addEventListener("click", closeConfirmModelModal);
  elements.cancelConfirmModelModal.addEventListener("click", closeConfirmModelModal);
  elements.confirmModelBackdrop.addEventListener("click", closeConfirmModelModal);
  elements.confirmModelChangeButton.addEventListener("click", confirmModelChange);
  elements.openConfigModal.addEventListener("click", openConfigModal);
  elements.scrollTopButton.addEventListener("click", scrollConversationTop);
  elements.scrollBottomButton.addEventListener("click", scrollConversationBottom);
  elements.closeConfigModal.addEventListener("click", closeConfigModal);
  elements.cancelConfigModal.addEventListener("click", closeConfigModal);
  elements.configBackdrop.addEventListener("click", closeConfigModal);
  elements.configForm.addEventListener("submit", onSaveConfig);
  elements.closeRenameModal.addEventListener("click", closeRenameModal);
  elements.cancelRenameModal.addEventListener("click", closeRenameModal);
  elements.renameBackdrop.addEventListener("click", closeRenameModal);
  elements.renameSessionForm.addEventListener("submit", onRenameSession);
  elements.closeDeleteModal.addEventListener("click", closeDeleteModal);
  elements.cancelDeleteModal.addEventListener("click", closeDeleteModal);
  elements.deleteBackdrop.addEventListener("click", closeDeleteModal);
  elements.confirmDeleteButton.addEventListener("click", onDeleteSession);
  elements.openCreateModal.addEventListener("click", openCreateModal);
  elements.closeCreateModal.addEventListener("click", closeCreateModal);
  elements.cancelCreateModal.addEventListener("click", closeCreateModal);
  elements.modalBackdrop.addEventListener("click", closeCreateModal);
  elements.toggleSidebar.addEventListener("click", toggleSidebar);
  elements.closeSidebar?.addEventListener("click", closeSidebar);
  elements.createSessionForm.addEventListener("submit", onCreateSession);
  elements.messageForm.addEventListener("submit", onSendMessage);
  elements.pickImagesButton.addEventListener("click", openImageModal);
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
      closeImageModal();
      closeModelModal();
      closeConfirmModelModal();
      closeRenameModal();
      closeDeleteModal();
      closeSidebar();
    }
  });
}

async function refreshBootstrap() {
  const response = await fetch("/api/bootstrap");
  state.bootstrap = await response.json();
  renderSessionList();
}

async function refreshCodexConfig() {
  const response = await fetch("/api/config/codex");
  if (!response.ok) {
    throw new Error("Impossible de charger la configuration Codex.");
  }
  state.codexConfig = await response.json();
  renderModelTrigger();
}

function renderModelTrigger() {
  elements.activeModelLabel.textContent = state.codexConfig.model || "gpt-5.4";
}

function renderModelList() {
  const models = state.codexConfig.availableModels || [];
  const activeModel = state.codexConfig.model || "gpt-5.4";

  elements.modelList.innerHTML = models
    .map((model) => {
      const active = model.slug === activeModel ? "active" : "";
      const description = model.description ? `<small>${escapeHtml(model.description)}</small>` : "";
      return `
        <button class="model-option ${active}" type="button" data-model-slug="${escapeHtml(model.slug)}">
          <span class="model-option-copy">
            <strong>${escapeHtml(model.label || model.slug)}</strong>
            ${description}
          </span>
          ${model.slug === activeModel ? '<i class="bi bi-check2-circle" aria-hidden="true"></i>' : '<i class="bi bi-circle" aria-hidden="true"></i>'}
        </button>
      `;
    })
    .join("");

  for (const button of elements.modelList.querySelectorAll("[data-model-slug]")) {
    button.addEventListener("click", () => {
      void requestModelChange(button.dataset.modelSlug);
    });
  }
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
      const statusLabel = session.status === "running" ? "En cours" : session.status;
      return `
        <article class="session-item ${active}" data-session-id="${session.id}">
          <div class="session-head">
            <button
              class="session-main"
              type="button"
              data-action="open"
              data-session-id="${session.id}"
              title="${escapeHtml(session.name)}"
            >
              <span class="session-name">${escapeHtml(session.name)}</span>
            </button>
            <div class="session-actions">
              <button class="session-action icon-button plain-button" type="button" data-action="rename" data-session-id="${session.id}" aria-label="Renommer ${escapeHtml(session.name)}">
                <i class="bi bi-pencil-fill icon-glyph" aria-hidden="true"></i>
              </button>
              <button class="session-action icon-button plain-button" type="button" data-action="delete" data-session-id="${session.id}" aria-label="Supprimer ${escapeHtml(session.name)}">
                <i class="bi bi-trash3-fill icon-glyph" aria-hidden="true"></i>
              </button>
            </div>
          </div>
          <div class="session-meta">
            <span class="mini-badge ${session.status === "running" ? "live" : "muted"}">${escapeHtml(statusLabel)}</span>
            <span class="mini-badge workspace-badge muted" title="${escapeHtml(session.workspaceName)}">${escapeHtml(session.workspaceName)}</span>
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
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const session = state.bootstrap.sessions.find((item) => item.id === button.dataset.sessionId);
      if (!session) {
        return;
      }
      openRenameModal(session);
    });
  }

  for (const button of elements.sessionList.querySelectorAll("[data-action='delete']")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const sessionId = button.dataset.sessionId;
      const session = state.bootstrap.sessions.find((item) => item.id === sessionId);
      if (!session) {
        return;
      }
      openDeleteModal(session);
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
      const body = escapeHtml(message.text || (message.pending ? "Codex réfléchit" : ""));
      return `
        <article class="bubble ${message.role} ${pending}">
          <div class="bubble-meta">${message.role === "user" ? "Vous" : "Codex"} · ${escapeHtml(formatDate(message.createdAt))}</div>
          <div class="bubble-body markdown-body">${renderMarkdown(body)}${
            message.pending ? '<span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>' : ""
          }</div>
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
  elements.activeMessageCount.textContent = session ? `${session.messageCount || 0} msg` : "";
  elements.activeWorkspace.textContent = session ? session.workspaceName || "" : "";
  elements.activeSessionName.textContent = session ? session.name || session.workspaceName || "" : "";
  const status = session?.status || "idle";
  elements.messageInput.disabled = status === "running";
  elements.pickImagesButton.disabled = status === "running";
  elements.clearComposerButton.disabled = status === "running";
  elements.sendButton.disabled = status === "running";
  renderComposerStatus(session);
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
  closeModelModal();
  closeConfirmModelModal();
  closeRenameModal();
  closeDeleteModal();
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

async function openConfigModal() {
  closeSidebar();
  closeCreateModal();
  closeImageModal();
  closeModelModal();
  closeConfirmModelModal();
  closeRenameModal();
  closeDeleteModal();
  try {
    await refreshCodexConfig();
  } catch {
    notify("error", "Chargement de la configuration impossible.");
    return;
  }
  elements.themeSelect.value = state.settings.theme;
  elements.notificationDurationInput.value = String(state.settings.notificationDurationSeconds);
  elements.sandboxDangerInput.checked = Boolean(state.codexConfig.sandboxDangerFullAccess);
  elements.approvalNeverInput.checked = Boolean(state.codexConfig.approvalNever);
  elements.hideFullAccessWarningInput.checked = Boolean(state.codexConfig.hideFullAccessWarning);
  elements.searchInput.checked = Boolean(state.codexConfig.search);
  elements.configModal.classList.add("open");
  elements.configModal.setAttribute("aria-hidden", "false");
}

function closeConfigModal() {
  elements.configModal.classList.remove("open");
  elements.configModal.setAttribute("aria-hidden", "true");
}

async function openModelModal() {
  closeSidebar();
  closeCreateModal();
  closeConfigModal();
  closeImageModal();
  closeRenameModal();
  closeDeleteModal();
  closeConfirmModelModal();
  try {
    await refreshCodexConfig();
  } catch {
    notify("error", "Chargement des modèles impossible.");
    return;
  }
  renderModelList();
  elements.modelModal.classList.add("open");
  elements.modelModal.setAttribute("aria-hidden", "false");
}

function closeModelModal() {
  elements.modelModal.classList.remove("open");
  elements.modelModal.setAttribute("aria-hidden", "true");
}

function openImageModal() {
  closeSidebar();
  closeCreateModal();
  closeConfigModal();
  closeModelModal();
  closeRenameModal();
  closeDeleteModal();
  closeConfirmModelModal();
  renderImageManager();
  elements.imageModal.classList.add("open");
  elements.imageModal.setAttribute("aria-hidden", "false");
}

function closeImageModal() {
  elements.imageModal.classList.remove("open");
  elements.imageModal.setAttribute("aria-hidden", "true");
}

function renderImageManager() {
  if (state.imagePickerBusy) {
    elements.imageManagerList.innerHTML = `<div class="image-empty image-loading">Ajout des images...</div>`;
    return;
  }

  if (!state.pendingAttachments.length) {
    elements.imageManagerList.innerHTML = `<div class="empty-state image-empty">Aucune image attachée.</div>`;
    return;
  }

  elements.imageManagerList.innerHTML = state.pendingAttachments
    .map((image) => {
      const safeName = escapeHtml(image.name || "image");
      return `
        <article class="image-card" data-image-id="${escapeHtml(image.id)}">
          <img class="image-preview" src="${escapeHtml(image.dataUrl)}" alt="${safeName}" />
          <div class="image-card-footer">
            <span class="image-name" title="${safeName}">${safeName}</span>
            <button class="icon-button plain-button image-remove-button" type="button" data-remove-image="${escapeHtml(image.id)}" aria-label="Retirer ${safeName}">
              <i class="bi bi-trash3-fill icon-glyph" aria-hidden="true"></i>
            </button>
          </div>
        </article>
      `;
    })
    .join("");

  for (const button of elements.imageManagerList.querySelectorAll("[data-remove-image]")) {
    button.addEventListener("click", () => {
      removePendingImage(button.dataset.removeImage);
    });
  }
}

function openConfirmModelModal(slug) {
  state.pendingModelSlug = slug;
  elements.confirmModelText.textContent = `Tu vas changer le modèle actif pour "${slug}" alors qu'une session est déjà en cours d'usage. Confirmer ?`;
  elements.confirmModelModal.classList.add("open");
  elements.confirmModelModal.setAttribute("aria-hidden", "false");
}

function closeConfirmModelModal() {
  state.pendingModelSlug = null;
  elements.confirmModelModal.classList.remove("open");
  elements.confirmModelModal.setAttribute("aria-hidden", "true");
}

function openRenameModal(session) {
  closeSidebar();
  closeCreateModal();
  closeConfigModal();
  closeDeleteModal();
  state.pendingRenameSessionId = session.id;
  elements.renameSessionInput.value = session.name || session.workspaceName || "";
  elements.renameModal.classList.add("open");
  elements.renameModal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    elements.renameSessionInput.focus();
    elements.renameSessionInput.select();
  }, 0);
}

function closeRenameModal() {
  state.pendingRenameSessionId = null;
  elements.renameModal.classList.remove("open");
  elements.renameModal.setAttribute("aria-hidden", "true");
}

function openDeleteModal(session) {
  closeSidebar();
  closeCreateModal();
  closeConfigModal();
  closeRenameModal();
  state.pendingDeleteSessionId = session.id;
  elements.deleteModalText.textContent = `Supprimer la session "${session.name || session.workspaceName}" ?`;
  elements.deleteModal.classList.add("open");
  elements.deleteModal.setAttribute("aria-hidden", "false");
}

function closeDeleteModal() {
  state.pendingDeleteSessionId = null;
  elements.deleteModal.classList.remove("open");
  elements.deleteModal.setAttribute("aria-hidden", "true");
}

function toggleSidebar() {
  elements.sidebar.classList.toggle("open");
}

function closeSidebar() {
  elements.sidebar.classList.remove("open");
}

async function requestModelChange(slug) {
  if (!slug || slug === state.codexConfig.model) {
    closeModelModal();
    return;
  }

  if (shouldConfirmModelChange()) {
    closeModelModal();
    openConfirmModelModal(slug);
    return;
  }

  await applyModelChange(slug);
}

function shouldConfirmModelChange() {
  if (!state.activeSessionId) {
    return false;
  }
  return state.messages.length > 0;
}

async function confirmModelChange() {
  const slug = state.pendingModelSlug;
  if (!slug) {
    return;
  }
  closeConfirmModelModal();
  await applyModelChange(slug);
}

async function applyModelChange(slug) {
  const payload = {
    model: slug,
    sandboxDangerFullAccess: Boolean(state.codexConfig.sandboxDangerFullAccess),
    approvalNever: Boolean(state.codexConfig.approvalNever),
    hideFullAccessWarning: Boolean(state.codexConfig.hideFullAccessWarning),
    search: Boolean(state.codexConfig.search),
  };

  const response = await fetch("/api/config/codex", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    notify("error", "Changement de modèle impossible.");
    return;
  }

  state.codexConfig = await response.json();
  renderModelTrigger();
  closeModelModal();
  notify("success", `Modèle actif: ${state.codexConfig.model}.`);
}

function scrollConversationTop() {
  elements.messages.scrollTo({ top: 0, behavior: "smooth" });
}

function scrollConversationBottom() {
  elements.messages.scrollTo({ top: elements.messages.scrollHeight, behavior: "smooth" });
}

async function onRenameSession(event) {
  event.preventDefault();
  if (!state.pendingRenameSessionId) {
    return;
  }

  const nextName = elements.renameSessionInput.value.trim();
  if (!nextName) {
    return;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(state.pendingRenameSessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nextName }),
  });

  if (!response.ok) {
    notify("error", "Renommage impossible.");
    return;
  }

  const payload = await response.json();
  state.bootstrap = payload.bootstrap;
  closeRenameModal();
  renderSessionList();

  if (state.activeSessionId === payload.session.id) {
    updateHeader(payload.session);
  }

  notify("success", "Nom de session mis a jour.");
}

async function onDeleteSession() {
  const sessionId = state.pendingDeleteSessionId;
  if (!sessionId) {
    return;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    notify("error", "Suppression impossible.");
    return;
  }

  const payload = await response.json();
  closeDeleteModal();

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

  notify("success", "Session supprimee.");
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

  state.imagePickerBusy = true;
  renderImageManager();

  const images = [];
  for (const file of files) {
    images.push({
      id: crypto.randomUUID(),
      name: file.name,
      dataUrl: await readFileAsDataUrl(file),
    });
  }

  state.imagePickerBusy = false;
  state.pendingAttachments.push(...images);
  elements.imageInput.value = "";
  renderImageManager();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);
  notify("success", `${images.length} image${images.length > 1 ? "s" : ""} ajoutée${images.length > 1 ? "s" : ""}.`);
}

function clearComposer() {
  elements.messageInput.value = "";
  elements.imageInput.value = "";
  state.imagePickerBusy = false;
  state.pendingAttachments = [];
  renderImageManager();
  autoResizeMessageInput();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);
}

function clearPendingImages() {
  state.imagePickerBusy = false;
  state.pendingAttachments = [];
  elements.imageInput.value = "";
  renderImageManager();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);
}

function removePendingImage(imageId) {
  state.pendingAttachments = state.pendingAttachments.filter((image) => image.id !== imageId);
  renderImageManager();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);
}

function buildComposerStatus(session) {
  const sessionStatus = session?.status || "idle";
  const base = session ? sessionStatus : "Aucune session";
  if (!state.pendingAttachments.length) {
    return base;
  }
  return `${base} · ${state.pendingAttachments.length} image${state.pendingAttachments.length > 1 ? "s" : ""}`;
}

function renderComposerStatus(session) {
  const status = session?.status || "idle";
  const label = escapeHtml(buildComposerStatus(session));
  const loading = status === "running" ? '<span class="loading-inline loading-inline-sm" aria-hidden="true"></span>' : "";
  elements.composerStatus.innerHTML = `${loading}<span>${label}</span>`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

async function onSaveConfig(event) {
  event.preventDefault();
  const theme = normalizeTheme(elements.themeSelect.value);
  const seconds = clampDuration(elements.notificationDurationInput.value);
  const payload = {
    model: state.codexConfig.model,
    sandboxDangerFullAccess: elements.sandboxDangerInput.checked,
    approvalNever: elements.approvalNeverInput.checked,
    hideFullAccessWarning: elements.hideFullAccessWarningInput.checked,
    search: elements.searchInput.checked,
  };

  const response = await fetch("/api/config/codex", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    notify("error", "Mise a jour de la configuration Codex impossible.");
    return;
  }

  state.settings.theme = theme;
  state.settings.notificationDurationSeconds = seconds;
  state.codexConfig = await response.json();
  localStorage.setItem(settingsKey, JSON.stringify(state.settings));
  applyTheme(theme);
  closeConfigModal();
  notify("success", `Configuration enregistree. Notifications a ${seconds}s.`);
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(settingsKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      theme: normalizeTheme(parsed.theme),
      notificationDurationSeconds: clampDuration(parsed.notificationDurationSeconds),
    };
  } catch {
    return { theme: "sandstone", notificationDurationSeconds: 5 };
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = normalizeTheme(theme);
}

function normalizeTheme(theme) {
  return themes.includes(theme) ? theme : "sandstone";
}

function clampDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return 5;
  }
  return Math.min(30, Math.max(1, Math.round(seconds)));
}

autoResizeMessageInput();
