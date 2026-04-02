import { marked } from "/assets/marked/marked.esm.js";

const themes = [
  "sandstone",
  "ivory-forest",
  "ocean-paper",
  "ember-night",
  "rose-studio",
  "midnight-cyan",
  "citrus-lab",
  "plum-ink",
  "arctic-glass",
  "terracotta-dusk",
];

const defaultQuickPrompts = [
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

function generateId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

marked.setOptions({
  breaks: true,
  gfm: true,
});

const state = {
  bootstrap: null,
  activeSessionId: null,
  socket: null,
  messages: [],
  auth: {
    enabled: false,
    authenticated: false,
    bootstrapped: false,
  },
  settings: defaultSettings(),
  appConfig: {
    workspaceRoot: "/projects",
  },
  secrets: [],
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
  pendingDeleteAction: null,
  pendingModelSlug: null,
  editingPromptId: null,
  editingSecretKey: null,
  sessionSearchTerm: "",
  sessionSearchResults: null,
  sessionSearchRequestId: 0,
  manualScrollLockUntil: 0,
  stt: {
    transcript: "",
    interim: "",
    listening: false,
    shouldKeepAlive: false,
    audioDetected: false,
    recognition: null,
    stream: null,
    audioContext: null,
    analyser: null,
    source: null,
    animationFrameId: null,
    restartTimerId: null,
  },
};

let settingsSavePromise = Promise.resolve();
let serverHealthPollTimer = 0;

const elements = {
  authGate: document.getElementById("authGate"),
  authForm: document.getElementById("authForm"),
  authTokenInput: document.getElementById("authTokenInput"),
  authHint: document.getElementById("authHint"),
  authSubmitButton: document.getElementById("authSubmitButton"),
  serverHealthIndicator: document.getElementById("serverHealthIndicator"),
  openModelModal: document.getElementById("openModelModal"),
  activeModelLabel: document.getElementById("activeModelLabel"),
  logoutButton: document.getElementById("logoutButton"),
  scrollTopButton: document.getElementById("scrollTopButton"),
  scrollBottomButton: document.getElementById("scrollBottomButton"),
  scrollDock: document.getElementById("scrollDock"),
  toggleMenuDrawer: document.getElementById("toggleMenuDrawer"),
  menuDrawer: document.getElementById("menuDrawer"),
  closeMenuDrawer: document.getElementById("closeMenuDrawer"),
  menuSessionsButton: document.getElementById("menuSessionsButton"),
  menuNewSessionButton: document.getElementById("menuNewSessionButton"),
  menuConfigButton: document.getElementById("menuConfigButton"),
  menuSecretsButton: document.getElementById("menuSecretsButton"),
  menuExportSessionButton: document.getElementById("menuExportSessionButton"),
  closeConfigModal: document.getElementById("closeConfigModal"),
  saveConfigButton: document.getElementById("saveConfigButton"),
  cancelConfigModal: document.getElementById("cancelConfigModal"),
  configModal: document.getElementById("configModal"),
  configBackdrop: document.getElementById("configBackdrop"),
  configForm: document.getElementById("configForm"),
  themeSelect: document.getElementById("themeSelect"),
  themeValueInput: document.getElementById("themeValueInput"),
  notificationDurationInput: document.getElementById("notificationDurationInput"),
  workspaceRootInput: document.getElementById("workspaceRootInput"),
  sandboxDangerInput: document.getElementById("sandboxDangerInput"),
  approvalNeverInput: document.getElementById("approvalNeverInput"),
  hideFullAccessWarningInput: document.getElementById("hideFullAccessWarningInput"),
  searchInput: document.getElementById("searchInput"),
  openPromptModal: document.getElementById("openPromptModal"),
  promptModal: document.getElementById("promptModal"),
  promptBackdrop: document.getElementById("promptBackdrop"),
  closePromptModal: document.getElementById("closePromptModal"),
  closePromptFooterButton: document.getElementById("closePromptFooterButton"),
  openPromptEditorButton: document.getElementById("openPromptEditorButton"),
  promptEditorModal: document.getElementById("promptEditorModal"),
  promptEditorBackdrop: document.getElementById("promptEditorBackdrop"),
  closePromptEditorModal: document.getElementById("closePromptEditorModal"),
  cancelPromptEditorButton: document.getElementById("cancelPromptEditorButton"),
  promptEditorModalTitle: document.getElementById("promptEditorModalTitle"),
  promptForm: document.getElementById("promptForm"),
  promptNameInput: document.getElementById("promptNameInput"),
  promptTextInput: document.getElementById("promptTextInput"),
  savePromptButton: document.getElementById("savePromptButton"),
  resetPromptFormButton: document.getElementById("resetPromptFormButton"),
  promptList: document.getElementById("promptList"),
  secretsModal: document.getElementById("secretsModal"),
  secretsBackdrop: document.getElementById("secretsBackdrop"),
  closeSecretsModal: document.getElementById("closeSecretsModal"),
  doneSecretsModalButton: document.getElementById("doneSecretsModalButton"),
  openCreateSecretButton: document.getElementById("openCreateSecretButton"),
  secretsList: document.getElementById("secretsList"),
  secretEditorModal: document.getElementById("secretEditorModal"),
  secretEditorBackdrop: document.getElementById("secretEditorBackdrop"),
  closeSecretEditorModal: document.getElementById("closeSecretEditorModal"),
  cancelSecretEditor: document.getElementById("cancelSecretEditor"),
  secretEditorModalTitle: document.getElementById("secretEditorModalTitle"),
  secretEditorForm: document.getElementById("secretEditorForm"),
  secretTypeInput: document.getElementById("secretTypeInput"),
  secretKeyInput: document.getElementById("secretKeyInput"),
  secretValueInput: document.getElementById("secretValueInput"),
  secretValueField: document.getElementById("secretValueField"),
  secretIdentifierField: document.getElementById("secretIdentifierField"),
  secretIdentifierInput: document.getElementById("secretIdentifierInput"),
  secretPasswordField: document.getElementById("secretPasswordField"),
  secretPasswordInput: document.getElementById("secretPasswordInput"),
  secretEditorHint: document.getElementById("secretEditorHint"),
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
  deleteModalTitle: document.getElementById("deleteModalTitle"),
  deleteBackdrop: document.getElementById("deleteBackdrop"),
  closeDeleteModal: document.getElementById("closeDeleteModal"),
  cancelDeleteModal: document.getElementById("cancelDeleteModal"),
  confirmDeleteButton: document.getElementById("confirmDeleteButton"),
  deleteModalText: document.getElementById("deleteModalText"),
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
  sessionSearchInput: document.getElementById("sessionSearchInput"),
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
  openSttModal: document.getElementById("openSttModal"),
  sttModal: document.getElementById("sttModal"),
  sttBackdrop: document.getElementById("sttBackdrop"),
  closeSttModal: document.getElementById("closeSttModal"),
  cancelSttButton: document.getElementById("cancelSttButton"),
  insertSttButton: document.getElementById("insertSttButton"),
  sttStatus: document.getElementById("sttStatus"),
  sttTranscript: document.getElementById("sttTranscript"),
  sttLevelMeter: document.getElementById("sttLevelMeter"),
  messages: document.getElementById("messages"),
  sendButton: document.getElementById("sendButton"),
  sendButtonIcon: document.getElementById("sendButtonIcon"),
  notifications: document.getElementById("notifications"),
};

bootstrap();

async function bootstrap() {
  bindEvents();
  applyTheme(state.settings.theme);
  startServerHealthPolling();
  if (!(await ensureAuthenticated())) {
    return;
  }
  await bootstrapApp();
}

async function bootstrapApp() {
  try {
    await refreshCodexConfig();
  } catch (error) {
    console.warn("Codex config bootstrap failed:", error);
  }
  try {
    await refreshAppConfig();
  } catch (error) {
    console.warn("App config bootstrap failed:", error);
  }
  try {
    await refreshUiState();
  } catch (error) {
    console.warn("UI state bootstrap failed:", error);
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
  elements.authForm.addEventListener("submit", onSubmitAuth);
  elements.openModelModal.addEventListener("click", openModelModal);
  elements.logoutButton.addEventListener("click", () => {
    void logout();
  });
  elements.openPromptModal.addEventListener("click", openPromptModal);
  elements.menuSecretsButton.addEventListener("click", () => {
    void openSecretsModal();
  });
  elements.closePromptModal.addEventListener("click", closePromptModal);
  elements.closePromptFooterButton.addEventListener("click", closePromptModal);
  elements.openPromptEditorButton.addEventListener("click", openCreatePromptEditor);
  elements.promptBackdrop.addEventListener("click", closePromptModal);
  elements.closePromptEditorModal.addEventListener("click", closePromptEditorModal);
  elements.cancelPromptEditorButton.addEventListener("click", closePromptEditorModal);
  elements.promptEditorBackdrop.addEventListener("click", closePromptEditorModal);
  elements.promptForm.addEventListener("submit", onSavePrompt);
  elements.closeSecretsModal.addEventListener("click", closeSecretsModal);
  elements.doneSecretsModalButton.addEventListener("click", closeSecretsModal);
  elements.openCreateSecretButton.addEventListener("click", openCreateSecretEditor);
  elements.secretsBackdrop.addEventListener("click", closeSecretsModal);
  elements.closeSecretEditorModal.addEventListener("click", closeSecretEditorModal);
  elements.cancelSecretEditor.addEventListener("click", closeSecretEditorModal);
  elements.secretEditorBackdrop.addEventListener("click", closeSecretEditorModal);
  elements.secretEditorForm.addEventListener("submit", onSaveSecret);
  elements.secretTypeInput.addEventListener("change", syncSecretEditorFields);
  elements.closeImageModal.addEventListener("click", closeImageModal);
  elements.doneImageModalButton.addEventListener("click", closeImageModal);
  elements.addMoreImagesButton.addEventListener("click", () => elements.imageInput.click());
  elements.clearImagesButton.addEventListener("click", clearPendingImages);
  elements.imageBackdrop.addEventListener("click", closeImageModal);
  elements.openSttModal.addEventListener("click", () => {
    void openSttModal();
  });
  elements.closeSttModal.addEventListener("click", () => {
    void closeSttModal();
  });
  elements.cancelSttButton.addEventListener("click", () => {
    void closeSttModal();
  });
  elements.insertSttButton.addEventListener("click", () => {
    void insertSttTranscript();
  });
  elements.sttBackdrop.addEventListener("click", () => {
    void closeSttModal();
  });
  elements.closeModelModal.addEventListener("click", closeModelModal);
  elements.modelBackdrop.addEventListener("click", closeModelModal);
  elements.closeConfirmModelModal.addEventListener("click", closeConfirmModelModal);
  elements.cancelConfirmModelModal.addEventListener("click", closeConfirmModelModal);
  elements.confirmModelBackdrop.addEventListener("click", closeConfirmModelModal);
  elements.confirmModelChangeButton.addEventListener("click", confirmModelChange);
  elements.toggleMenuDrawer.addEventListener("click", toggleMenuDrawer);
  elements.closeMenuDrawer?.addEventListener("click", closeMenuDrawer);
  elements.menuSessionsButton?.addEventListener("click", () => {
    closeMenuDrawer();
    elements.sidebar.classList.add("open");
  });
  elements.menuNewSessionButton.addEventListener("click", openCreateModal);
  elements.menuConfigButton.addEventListener("click", openConfigModal);
  elements.menuExportSessionButton.addEventListener("click", () => {
    void exportActiveSession();
  });
  elements.scrollTopButton.addEventListener("click", scrollConversationTop);
  elements.scrollBottomButton.addEventListener("click", scrollConversationBottom);
  elements.closeConfigModal.addEventListener("click", closeConfigModal);
  elements.cancelConfigModal.addEventListener("click", closeConfigModal);
  elements.configBackdrop.addEventListener("click", closeConfigModal);
  elements.configForm.addEventListener("submit", onSaveConfig);
  elements.themeSelect.addEventListener("change", onThemeSelectionChange);
  elements.saveConfigButton.addEventListener("pointerdown", syncThemeSelectionValue);
  elements.saveConfigButton.addEventListener("click", syncThemeSelectionValue);
  elements.closeRenameModal.addEventListener("click", closeRenameModal);
  elements.cancelRenameModal.addEventListener("click", closeRenameModal);
  elements.renameBackdrop.addEventListener("click", closeRenameModal);
  elements.renameSessionForm.addEventListener("submit", onRenameSession);
  elements.closeDeleteModal.addEventListener("click", closeDeleteModal);
  elements.cancelDeleteModal.addEventListener("click", closeDeleteModal);
  elements.deleteBackdrop.addEventListener("click", closeDeleteModal);
  elements.confirmDeleteButton.addEventListener("click", () => {
    void onConfirmDelete();
  });
  elements.closeCreateModal.addEventListener("click", closeCreateModal);
  elements.cancelCreateModal.addEventListener("click", closeCreateModal);
  elements.modalBackdrop.addEventListener("click", closeCreateModal);
  elements.toggleSidebar.addEventListener("click", toggleSidebar);
  elements.closeSidebar?.addEventListener("click", closeSidebar);
  elements.createSessionForm.addEventListener("submit", onCreateSession);
  elements.messageForm.addEventListener("submit", onSendMessage);
  elements.sessionSearchInput.addEventListener("input", onSessionSearch);
  elements.pickImagesButton.addEventListener("click", openImageModal);
  elements.clearComposerButton.addEventListener("click", clearComposer);
  elements.imageInput.addEventListener("change", onPickImages);
  elements.messages.addEventListener("scroll", updateScrollDockVisibility);
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
      closeMenuDrawer();
      closeConfigModal();
      closePromptModal();
      closePromptEditorModal();
      closeImageModal();
      void closeSttModal();
      closeModelModal();
      closeConfirmModelModal();
      closeRenameModal();
      closeDeleteModal();
      closeSidebar();
      closeMenuDrawer();
    }
  });
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    handleUnauthorized();
  }
  return response;
}

function handleUnauthorized() {
  disconnectSocket();
  state.auth.authenticated = false;
  state.activeSessionId = null;
  state.messages = [];
  openAuthGate("Session expiree. Reconnecte-toi.");
}

async function ensureAuthenticated() {
  try {
    const response = await fetch("/api/auth/status");
    if (!response.ok) {
      throw new Error("Auth status failed");
    }
    const payload = await response.json();
    state.auth.enabled = Boolean(payload.enabled);
    state.auth.authenticated = Boolean(payload.authenticated);
    state.auth.bootstrapped = true;

    if (!state.auth.enabled || state.auth.authenticated) {
      closeAuthGate();
      return true;
    }

    openAuthGate();
    return false;
  } catch {
    openAuthGate("Impossible de verifier l'acces. Reessaie.");
    return false;
  }
}

function openAuthGate(message = "Saisis le token d'accès pour ouvrir l'interface.") {
  document.body.classList.add("auth-locked");
  elements.authGate.classList.add("open");
  elements.authGate.setAttribute("aria-hidden", "false");
  elements.authHint.textContent = message;
  elements.authHint.hidden = message === "Saisis le token d'accès pour ouvrir l'interface.";
  window.setTimeout(() => {
    elements.authTokenInput.focus();
  }, 0);
}

function startServerHealthPolling() {
  void refreshServerHealth();
  if (serverHealthPollTimer) {
    window.clearInterval(serverHealthPollTimer);
  }
  serverHealthPollTimer = window.setInterval(() => {
    void refreshServerHealth();
  }, 3000);
}

async function refreshServerHealth() {
  try {
    const response = await fetch("/api/health", { credentials: "same-origin" });
    const payload = response.ok ? await response.json() : null;
    updateServerHealthIndicator(Boolean(response.ok && payload?.ok && payload?.runtimeOk));
  } catch {
    updateServerHealthIndicator(false);
  }
}

function updateServerHealthIndicator(isHealthy) {
  elements.serverHealthIndicator.classList.toggle("ok", isHealthy);
  elements.serverHealthIndicator.classList.toggle("down", !isHealthy);
  elements.serverHealthIndicator.setAttribute("title", isHealthy ? "Serveur et runtime disponibles" : "Serveur ou runtime indisponible");
  elements.serverHealthIndicator.setAttribute("aria-label", isHealthy ? "Serveur et runtime disponibles" : "Serveur ou runtime indisponible");
}

function closeAuthGate() {
  document.body.classList.remove("auth-locked");
  elements.authGate.classList.remove("open");
  elements.authGate.setAttribute("aria-hidden", "true");
  elements.authTokenInput.value = "";
  elements.authHint.hidden = true;
}

async function onSubmitAuth(event) {
  event.preventDefault();
  const token = elements.authTokenInput.value.trim();
  if (!token) {
    elements.authHint.textContent = "Le token est requis.";
    elements.authHint.hidden = false;
    return;
  }

  elements.authSubmitButton.disabled = true;
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null);
  elements.authSubmitButton.disabled = false;

  if (!response?.ok) {
    elements.authHint.textContent = "Token invalide.";
    elements.authHint.hidden = false;
    return;
  }

  state.auth.authenticated = true;
  closeAuthGate();
  try {
    await bootstrapApp();
    notify("success", "Connexion reussie.");
  } catch {
    openAuthGate("Connexion etablie, mais chargement impossible.");
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}
  closeMenuDrawer();
  handleUnauthorized();
  notify("success", "Déconnecté.");
}

async function refreshBootstrap() {
  const response = await apiFetch("/api/bootstrap");
  state.bootstrap = await response.json();
  if (state.sessionSearchTerm.trim()) {
    state.sessionSearchResults = null;
    void runSessionSearch(state.sessionSearchTerm);
  }
  renderSessionList();
}

async function refreshCodexConfig() {
  const response = await apiFetch("/api/config/codex");
  if (!response.ok) {
    throw new Error("Impossible de charger la configuration Codex.");
  }
  state.codexConfig = await response.json();
  renderModelTrigger();
}

async function refreshAppConfig() {
  const response = await apiFetch("/api/config/app");
  if (!response.ok) {
    throw new Error("Impossible de charger la configuration application.");
  }
  state.appConfig = await response.json();
}

async function refreshSecrets() {
  const response = await apiFetch("/api/secrets");
  if (!response.ok) {
    throw new Error("Impossible de charger les secrets.");
  }
  const payload = await response.json();
  state.secrets = Array.isArray(payload.secrets) ? payload.secrets : [];
}

async function refreshUiState() {
  const response = await apiFetch("/api/ui-state");
  if (!response.ok) {
    throw new Error("Impossible de charger l'état d'interface.");
  }
  const payload = await response.json();
  state.settings = normalizeSettings(payload);
  applyTheme(state.settings.theme);
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
  const query = state.sessionSearchTerm.trim();
  const filteredSessions = query ? state.sessionSearchResults || [] : sessions;
  const workspaces = [...new Set(filteredSessions.map((session) => session.workspaceName))];

  elements.sessionCount.textContent = `${filteredSessions.length} session${filteredSessions.length > 1 ? "s" : ""}`;
  elements.workspaceCount.textContent = `${workspaces.length} workspace${workspaces.length > 1 ? "s" : ""}`;

  if (!filteredSessions.length) {
    const text = sessions.length ? "Aucun résultat." : "Aucune session.";
    const hint = sessions.length
      ? "Essaie un autre mot-clé ou le nom du workspace."
      : "Crée une première session pour lancer un tour Codex.";
    elements.sessionList.innerHTML = `
      <div class="empty-state-panel">
        <i class="bi bi-chat-left-text" aria-hidden="true"></i>
        <p class="empty-state">${text}</p>
        <small>${hint}</small>
      </div>
    `;
    return;
  }

  elements.sessionList.innerHTML = filteredSessions
    .map((session) => {
      const active = session.id === state.activeSessionId ? "active" : "";
      const statusLabel = session.status === "running" ? "En cours" : session.status;
      return `
        <article class="session-item ${active}" data-session-id="${session.id}">
          <div class="session-head">
            <button
              class="session-main"
              type="button"
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

  for (const item of elements.sessionList.querySelectorAll(".session-item")) {
    item.addEventListener("click", async () => {
      await activateSession(item.dataset.sessionId);
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
      openDeleteSessionModal(session);
    });
  }
}

function onSessionSearch(event) {
  state.sessionSearchTerm = String(event.target.value || "");
  state.sessionSearchRequestId += 1;
  const requestId = state.sessionSearchRequestId;
  const query = state.sessionSearchTerm.trim();

  if (!query) {
    window.clearTimeout(onSessionSearch.timerId);
    state.sessionSearchResults = null;
    renderSessionList();
    return;
  }

  window.clearTimeout(onSessionSearch.timerId);
  onSessionSearch.timerId = window.setTimeout(() => {
    void runSessionSearch(query, requestId);
  }, 160);
  renderSessionList();
}

onSessionSearch.timerId = 0;

async function runSessionSearch(query, requestId = state.sessionSearchRequestId) {
  try {
    const response = await apiFetch(`/api/sessions/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      throw new Error("search failed");
    }
    const payload = await response.json();
    if (requestId !== state.sessionSearchRequestId) {
      return;
    }
    state.sessionSearchResults = Array.isArray(payload.sessions) ? payload.sessions : [];
    renderSessionList();
  } catch {
    if (requestId !== state.sessionSearchRequestId) {
      return;
    }
    state.sessionSearchResults = [];
    renderSessionList();
    notify("error", "Recherche impossible.");
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
  updateHeader(session);
  renderSessionList();
  renderMessages();
  await connectSocket(sessionId);
  void persistSettings({ lastSessionId: sessionId });
}

function connectSocket(sessionId) {
  return new Promise((resolve) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`);
    state.socket = socket;

    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve();
    };

    const timeoutId = window.setTimeout(() => {
      settle();
    }, 3000);

    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "bootstrap") {
        state.messages = message.messages || [];
        upsertSessionSummary(message.session);
        updateHeader(message.session);
        renderMessages(true);
        settle();
        return;
      }

      if (message.type === "message") {
        upsertMessage(message.message);
        upsertSessionSummary(message.session);
        updateHeader(message.session);
        renderMessages(true);
        await refreshBootstrap();
        return;
      }

      if (message.type === "message.updated") {
        upsertMessage(message.message);
        upsertSessionSummary(message.session);
        updateHeader(message.session);
        renderMessages(true);
        await refreshBootstrap();
        return;
      }

      if (message.type === "status") {
        upsertSessionSummary(message.session);
        updateHeader(message.session);
        renderMessages(false);
        await refreshBootstrap();
      }
    });

    socket.addEventListener("error", () => {
      settle();
    });

    socket.addEventListener("close", async () => {
      settle();
      if (state.socket === socket) {
        state.socket = null;
        await refreshBootstrap();
        const session = state.bootstrap.sessions.find((item) => item.id === state.activeSessionId);
        if (session) {
          updateHeader(session);
        }
      }
    });
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
  const response = await apiFetch("/api/sessions", {
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
  closeSidebar();
  notify("success", "Session créée.");
  await activateSession(payload.session.id);
}

async function onSendMessage(event) {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  const hasDraft = Boolean(text) || state.pendingAttachments.length > 0;
  if (!state.activeSessionId) {
    notify("warning", "Selectionne d'abord une session.");
    return;
  }
  if (isActiveSessionRunning()) {
    if (hasDraft) {
      notify("info", "Attends la fin du tour avant d'envoyer un nouveau message.");
      return;
    }
    const response = await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/interrupt`, {
      method: "POST",
    });
    if (response.status === 409) {
      notify("info", "Aucune reponse en cours.");
      return;
    }
    if (!response.ok) {
      notify("error", "Interruption impossible.");
      return;
    }
    notify("success", "Reponse interrompue.");
    return;
  }
  if (!hasDraft) {
    return;
  }
  if (state.pendingAttachments.some((attachment) => attachment.uploading)) {
    notify("info", "Attends la fin de l'upload des pièces jointes.");
    return;
  }
  if (state.pendingAttachments.some((attachment) => attachment.uploadError)) {
    notify("warning", "Supprime les pièces jointes en erreur avant d'envoyer.");
    return;
  }

  const attachments = [...state.pendingAttachments];

  const response = await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/message`, {
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

  const payload = await response.json();
  resetComposerState();
  if (state.activeSessionId === payload.session?.id) {
    state.messages = Array.isArray(payload.messages) ? payload.messages : state.messages;
    upsertSessionSummary(payload.session);
    updateHeader(payload.session);
    renderMessages(true);
  }
}

function renderMessages(shouldScroll = false) {
  if (!state.messages.length) {
    elements.messages.innerHTML = `
      <div class="empty-chat">
        <i class="bi bi-stars" aria-hidden="true"></i>
        <strong>Aucune conversation active</strong>
        <p>Démarre une session puis écris à Codex.</p>
      </div>
    `;
    updateScrollDockVisibility();
    return;
  }

  const latestUserMessageId = [...state.messages].reverse().find((message) => message.role === "user")?.id || null;
  const sessionRunning = state.messages.some((message) => message.role === "assistant" && message.pending);

  elements.messages.innerHTML = state.messages
    .map((message) => {
      const pending = message.pending ? "pending" : "";
      const body = escapeHtml(message.text || (message.pending ? "Codex réfléchit" : ""));
      const canRetry = message.role === "user" && message.id === latestUserMessageId;
      const roleLabel = message.role === "user" ? "Vous" : "Codex";
      const roleClass = message.role === "user" ? "user" : "assistant";
      const attachmentsMarkup = renderMessageAttachments(message);
      return `
        <article class="bubble ${message.role} ${pending}">
          <div class="bubble-tools">
            ${canRetry ? `
              <button
                class="bubble-copy"
                type="button"
                data-retry-message-id="${escapeHtml(message.id)}"
                aria-label="Relancer ce message"
                ${sessionRunning ? "disabled" : ""}
              >
                <i class="bi bi-arrow-repeat" aria-hidden="true"></i>
              </button>
            ` : ""}
            <button class="bubble-copy" type="button" data-copy-message-id="${escapeHtml(message.id)}" aria-label="Copier le message">
              <i class="bi bi-copy" aria-hidden="true"></i>
            </button>
          </div>
          <div class="bubble-meta">
            <span class="bubble-role ${roleClass}">${roleLabel}</span>
            <span class="bubble-time">${escapeHtml(formatDate(message.createdAt))}</span>
          </div>
          <div class="bubble-body markdown-body">${renderMarkdown(body)}${
            message.pending ? '<span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>' : ""
          }</div>
          ${attachmentsMarkup}
        </article>
      `;
    })
    .join("");

  for (const button of elements.messages.querySelectorAll("[data-copy-message-id]")) {
    button.addEventListener("click", () => {
      void copyMessageToClipboard(button.dataset.copyMessageId);
    });
  }

  for (const button of elements.messages.querySelectorAll("[data-retry-message-id]")) {
    button.addEventListener("click", () => {
      void retryLastUserMessage();
    });
  }

  enhanceCodeBlocks();

  if (shouldScroll) {
    if (Date.now() < state.manualScrollLockUntil) {
      updateScrollDockVisibility();
      return;
    }
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  updateScrollDockVisibility();
}

function renderMessageAttachments(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.length || !state.activeSessionId) {
    return "";
  }

  return `
    <div class="bubble-attachments">
      ${attachments
        .map((attachment) => renderMessageAttachmentCard(message.id, attachment))
        .join("")}
    </div>
  `;
}

function renderMessageAttachmentCard(messageId, attachment) {
  const safeName = escapeHtml(attachment?.name || "Pièce jointe");
  const typeLabel = escapeHtml(formatAttachmentType(attachment?.mimeType));
  const url = buildMessageAttachmentUrl(messageId, attachment?.id);

  if (attachment?.isImage && url) {
    return `
      <a class="bubble-attachment bubble-attachment-image" href="${url}" target="_blank" rel="noreferrer noopener" aria-label="Ouvrir ${safeName}">
        <img class="bubble-attachment-thumb" src="${url}" alt="${safeName}" loading="lazy" />
        <span class="bubble-attachment-caption" title="${safeName}">${safeName}</span>
      </a>
    `;
  }

  return `
    <a class="bubble-attachment bubble-attachment-file" href="${url}" target="_blank" rel="noreferrer noopener" aria-label="Ouvrir ${safeName}">
      <span class="bubble-attachment-icon" aria-hidden="true"><i class="bi ${escapeHtml(pickAttachmentIcon(attachment?.mimeType, attachment?.name))}"></i></span>
      <span class="bubble-attachment-copy">
        <strong title="${safeName}">${safeName}</strong>
        <small>${typeLabel}</small>
      </span>
    </a>
  `;
}

function buildMessageAttachmentUrl(messageId, attachmentId) {
  if (!state.activeSessionId || !messageId || !attachmentId) {
    return "";
  }
  return `/api/sessions/${encodeURIComponent(state.activeSessionId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(
    attachmentId
  )}`;
}

function enhanceCodeBlocks() {
  for (const pre of elements.messages.querySelectorAll(".markdown-body pre")) {
    if (pre.parentElement?.classList.contains("code-block")) {
      continue;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.append(pre);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.setAttribute("aria-label", "Copier le bloc de code");
    button.innerHTML = '<i class="bi bi-copy" aria-hidden="true"></i>';
    button.addEventListener("click", async () => {
      const codeText = pre.querySelector("code")?.innerText || pre.innerText || "";
      const text = codeText.trim();
      if (!text) {
        notify("warning", "Bloc de code vide.");
        return;
      }
      try {
        await writeClipboardText(text);
        notify("success", "Code copié.");
      } catch {
        notify("error", "Copie du code impossible.");
      }
    });
    wrapper.append(button);
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

function upsertSessionSummary(session) {
  if (!state.bootstrap?.sessions || !session?.id) {
    return;
  }
  const index = state.bootstrap.sessions.findIndex((item) => item.id === session.id);
  if (index === -1) {
    return;
  }
  state.bootstrap.sessions[index] = {
    ...state.bootstrap.sessions[index],
    ...session,
  };
}

function isActiveSessionRunning() {
  if (state.messages.some((message) => message.role === "assistant" && message.pending)) {
    return true;
  }
  return getActiveSession()?.status === "running";
}

function updateHeader(session) {
  elements.activeMessageCount.textContent = session ? `${session.messageCount || 0} msg` : "";
  elements.activeWorkspace.textContent = session ? session.workspaceName || "" : "";
  elements.activeSessionName.textContent = session ? session.name || session.workspaceName || "" : "";
  const running = Boolean(session) && isActiveSessionRunning();
  const status = running ? "running" : session?.status || "idle";
  elements.messageInput.disabled = status === "running";
  elements.pickImagesButton.disabled = status === "running";
  elements.clearComposerButton.disabled = status === "running";
  elements.openSttModal.disabled = status === "running";
  elements.sendButton.disabled = !session;
  renderSendButton(session, running);
  renderComposerStatus(session, running);
  elements.composerStatus.className = `composer-status badge-status ${status === "idle" ? "idle" : "live"}`;
}

function renderSendButton(session, running = Boolean(session) && isActiveSessionRunning()) {
  elements.sendButton.setAttribute("aria-label", running ? "Interrompre" : "Envoyer");
  elements.sendButton.title = running ? "Interrompre Codex" : "Envoyer";
  elements.sendButton.classList.toggle("stop-mode", running);
  elements.sendButtonIcon.className = running ? "bi bi-stop-fill send-icon" : "bi bi-send-fill send-icon";
}

function getActiveSession() {
  return state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null;
}

function pickSessionId() {
  const sessions = state.bootstrap?.sessions || [];
  if (!sessions.length) {
    return null;
  }
  const server = state.bootstrap.lastSessionId;
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
  elements.openSttModal.disabled = isBusy;
  elements.sendButton.disabled = isBusy || !state.activeSessionId;
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
  closeMenuDrawer();
  closeConfigModal();
  closePromptModal();
  void closeSttModal();
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
  closeMenuDrawer();
  closeCreateModal();
  closePromptModal();
  closeSecretsModal();
  closeImageModal();
  await closeSttModal();
  closeModelModal();
  closeConfirmModelModal();
  closeRenameModal();
  closeDeleteModal();
  try {
    await Promise.all([refreshCodexConfig(), refreshAppConfig(), refreshUiState()]);
  } catch {
    notify("error", "Chargement de la configuration impossible.");
    return;
  }
  elements.themeSelect.value = state.settings.theme;
  elements.themeValueInput.value = state.settings.theme;
  elements.notificationDurationInput.value = String(state.settings.notificationDurationSeconds);
  elements.workspaceRootInput.value = state.appConfig.workspaceRoot || "/projects";
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

async function openSecretsModal() {
  closeSidebar();
  closeMenuDrawer();
  closeCreateModal();
  closeConfigModal();
  closeSecretsModal();
  closePromptModal();
  closeImageModal();
  await closeSttModal();
  closeModelModal();
  closeConfirmModelModal();
  closeRenameModal();
  closeDeleteModal();
  try {
    await refreshSecrets();
  } catch {
    notify("error", "Chargement des secrets impossible.");
    return;
  }
  renderSecretsList();
  elements.secretsModal.classList.add("open");
  elements.secretsModal.setAttribute("aria-hidden", "false");
}

function closeSecretsModal() {
  closeSecretEditorModal();
  elements.secretsModal.classList.remove("open");
  elements.secretsModal.setAttribute("aria-hidden", "true");
}

function resetSecretForm() {
  state.editingSecretKey = null;
  elements.secretEditorModalTitle.textContent = "Nouveau secret";
  elements.secretTypeInput.value = "value";
  elements.secretKeyInput.value = "";
  elements.secretKeyInput.disabled = false;
  elements.secretValueInput.value = "";
  elements.secretIdentifierInput.value = "";
  elements.secretPasswordInput.value = "";
  elements.secretValueInput.placeholder = "Valeur du secret";
  elements.secretEditorHint.innerHTML = `<i class="bi bi-info-circle-fill" aria-hidden="true"></i><span>La valeur n'est jamais affichée dans la liste.</span>`;
  syncSecretEditorFields();
}

function openCreateSecretEditor() {
  resetSecretForm();
  openSecretEditorModal();
}

function openEditSecretEditor(secret) {
  state.editingSecretKey = secret.key;
  elements.secretEditorModalTitle.textContent = "Modifier le secret";
  elements.secretTypeInput.value = secret.type || "value";
  elements.secretKeyInput.value = secret.key;
  elements.secretKeyInput.disabled = secret.canEditKey === false;
  elements.secretValueInput.value = "";
  elements.secretIdentifierInput.value = "";
  elements.secretPasswordInput.value = "";
  elements.secretValueInput.placeholder = "Laisser vide pour conserver la valeur";
  elements.secretEditorHint.innerHTML =
    secret.type === "credentials"
      ? `<i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i><span>Laisse les champs vides pour conserver les identifiants existants.</span>`
      : `<i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i><span>Laisse la valeur vide pour conserver le secret existant.</span>`;
  syncSecretEditorFields();
  openSecretEditorModal();
}

function openSecretEditorModal() {
  elements.secretEditorModal.classList.add("open");
  elements.secretEditorModal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    elements.secretKeyInput.focus();
    if (!state.editingSecretKey) {
      elements.secretKeyInput.select();
    }
  }, 0);
}

function closeSecretEditorModal() {
  state.editingSecretKey = null;
  elements.secretEditorModal.classList.remove("open");
  elements.secretEditorModal.setAttribute("aria-hidden", "true");
}

function syncSecretEditorFields() {
  const credentials = elements.secretTypeInput.value === "credentials";
  elements.secretValueField.hidden = credentials;
  elements.secretValueField.setAttribute("aria-hidden", credentials ? "true" : "false");
  elements.secretValueInput.disabled = credentials;
  elements.secretValueInput.required = !credentials && !state.editingSecretKey;

  elements.secretIdentifierField.hidden = !credentials;
  elements.secretIdentifierField.setAttribute("aria-hidden", credentials ? "false" : "true");
  elements.secretIdentifierInput.disabled = !credentials;
  elements.secretIdentifierInput.required = credentials && !state.editingSecretKey;

  elements.secretPasswordField.hidden = !credentials;
  elements.secretPasswordField.setAttribute("aria-hidden", credentials ? "false" : "true");
  elements.secretPasswordInput.disabled = !credentials;
  elements.secretPasswordInput.required = credentials && !state.editingSecretKey;
}

function renderSecretsList() {
  if (!state.secrets.length) {
    elements.secretsList.innerHTML = `
      <div class="empty-state-panel compact">
        <i class="bi bi-key" aria-hidden="true"></i>
        <p class="empty-state">Aucun secret enregistré.</p>
        <small>Ajoute ici tes tokens et identifiants d'infrastructure.</small>
      </div>
    `;
    return;
  }

  elements.secretsList.innerHTML = state.secrets
    .map((secret) => {
      const deleteDisabled = secret.canDelete === false ? " disabled aria-disabled=\"true\"" : "";
      const deleteDisabledClass = secret.canDelete === false ? " is-disabled" : "";
      return `
      <article class="secret-item">
        <button class="secret-main" type="button" data-secret-edit="${escapeHtml(secret.key)}">
          <div class="secret-copy">
            <strong title="${escapeHtml(secret.key)}">${escapeHtml(secret.key)}</strong>
            <div class="secret-meta">
              <span class="mini-badge muted">${secret.type === "credentials" ? "Identifiants" : "Valeur"}</span>
              <span class="mini-badge ${secret.hasValue ? "live" : "muted"}" title="${secret.hasValue ? "Enregistré" : "Vide"}">${secret.hasValue ? '<i class="bi bi-floppy-fill" aria-hidden="true"></i>' : "Vide"}</span>
              ${secret.protected ? '<span class="mini-badge muted" title="Protégé"><i class="bi bi-shield-lock-fill" aria-hidden="true"></i></span>' : ""}
            </div>
          </div>
        </button>
        <div class="secret-actions">
          <button class="icon-button plain-button" type="button" data-secret-edit="${escapeHtml(secret.key)}" aria-label="Modifier ${escapeHtml(secret.key)}">
            <i class="bi bi-pencil-fill icon-glyph" aria-hidden="true"></i>
          </button>
          <button class="icon-button plain-button${deleteDisabledClass}" type="button" data-secret-delete="${escapeHtml(secret.key)}" aria-label="Supprimer ${escapeHtml(secret.key)}"${deleteDisabled}>
            <i class="bi bi-trash3-fill icon-glyph" aria-hidden="true"></i>
          </button>
        </div>
      </article>
    `;
    })
    .join("");

  for (const button of elements.secretsList.querySelectorAll("[data-secret-edit]")) {
    button.addEventListener("click", () => {
      const secret = state.secrets.find((item) => item.key === button.dataset.secretEdit);
      if (secret) {
        openEditSecretEditor(secret);
      }
    });
  }

  for (const button of elements.secretsList.querySelectorAll("[data-secret-delete]")) {
    button.addEventListener("click", () => {
      if (button.disabled) {
        return;
      }
      requestDeleteSecret(button.dataset.secretDelete);
    });
  }
}

function onThemeSelectionChange(event) {
  const theme = normalizeTheme(event.target.value);
  elements.themeValueInput.value = theme;
  state.settings.theme = theme;
  persistSettings();
  applyTheme(theme);
}

function syncThemeSelectionValue() {
  elements.themeValueInput.value = normalizeTheme(elements.themeSelect.value);
}

async function openModelModal() {
  closeSidebar();
  closeMenuDrawer();
  closeCreateModal();
  closeConfigModal();
  closePromptModal();
  closeImageModal();
  await closeSttModal();
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

function openPromptModal() {
  closeSidebar();
  closeMenuDrawer();
  closeCreateModal();
  closeConfigModal();
  closeSecretsModal();
  closeImageModal();
  void closeSttModal();
  closeModelModal();
  closeConfirmModelModal();
  closeRenameModal();
  closeDeleteModal();
  renderPromptList();
  elements.promptModal.classList.add("open");
  elements.promptModal.setAttribute("aria-hidden", "false");
}

function closePromptModal() {
  closePromptEditorModal();
  elements.promptModal.classList.remove("open");
  elements.promptModal.setAttribute("aria-hidden", "true");
}

function openCreatePromptEditor() {
  resetPromptForm();
  elements.promptEditorModalTitle.textContent = "Nouveau prompt";
  openPromptEditorModal();
}

function openPromptEditorModal() {
  elements.promptEditorModal.classList.add("open");
  elements.promptEditorModal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => {
    elements.promptNameInput.focus();
  }, 0);
}

function closePromptEditorModal() {
  elements.promptEditorModal.classList.remove("open");
  elements.promptEditorModal.setAttribute("aria-hidden", "true");
}

function closeModelModal() {
  elements.modelModal.classList.remove("open");
  elements.modelModal.setAttribute("aria-hidden", "true");
}

function openImageModal() {
  closeSidebar();
  closeCreateModal();
  closeConfigModal();
  closeSecretsModal();
  closePromptModal();
  void closeSttModal();
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

async function openSttModal() {
  closeSidebar();
  closeCreateModal();
  closeConfigModal();
  closeSecretsModal();
  closePromptModal();
  closeImageModal();
  closeModelModal();
  closeConfirmModelModal();
  closeRenameModal();
  closeDeleteModal();
  resetSttUi();
  state.stt.shouldKeepAlive = true;
  elements.sttModal.classList.add("open");
  elements.sttModal.setAttribute("aria-hidden", "false");

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition || !navigator.mediaDevices?.getUserMedia) {
    elements.sttStatus.textContent = "Reconnaissance vocale non disponible.";
    elements.sttTranscript.textContent = "Utilise un navigateur compatible micro + Web Speech API.";
    return;
  }

  try {
    await hydrateMicrophonePermission();
    await startSttCapture(SpeechRecognition);
  } catch {
    elements.sttStatus.textContent = "Accès micro impossible.";
    elements.sttTranscript.textContent = "Autorise le micro puis réessaie.";
    notify("error", "Impossible de démarrer la dictée vocale.");
  }
}

async function closeSttModal() {
  state.stt.shouldKeepAlive = false;
  await stopSttCapture();
  elements.sttModal.classList.remove("open");
  elements.sttModal.setAttribute("aria-hidden", "true");
}

function resetSttUi() {
  state.stt.transcript = "";
  state.stt.interim = "";
  state.stt.audioDetected = false;
  elements.sttStatus.textContent = "Initialisation…";
  elements.sttTranscript.textContent = "Parle pour dicter ton message.";
  updateSttVisualizer(0.16);
}

async function hydrateMicrophonePermission() {
  if (!navigator.permissions?.query) {
    return;
  }
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    if (status.state === "denied") {
      elements.sttStatus.textContent = "Micro refusé.";
      elements.sttTranscript.textContent = "Le navigateur bloque le micro. Autorise-le dans les réglages du site.";
    } else if (status.state === "prompt") {
      elements.sttStatus.textContent = "Autorise le micro…";
    }
  } catch {}
}

async function startSttCapture(SpeechRecognition) {
  await stopSttCapture();

  state.stt.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass) {
    state.stt.audioContext = new AudioContextClass();
    if (state.stt.audioContext.state === "suspended") {
      await state.stt.audioContext.resume().catch(() => {});
    }
    state.stt.source = state.stt.audioContext.createMediaStreamSource(state.stt.stream);
    state.stt.analyser = state.stt.audioContext.createAnalyser();
    state.stt.analyser.fftSize = 128;
    state.stt.source.connect(state.stt.analyser);
    animateSttVisualizer();
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    state.stt.listening = true;
    elements.sttStatus.textContent = "Je t’écoute…";
  };
  recognition.onresult = (event) => {
    let finalText = state.stt.transcript;
    let interimText = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index]?.[0]?.transcript?.trim() || "";
      if (!transcript) {
        continue;
      }
      if (event.results[index].isFinal) {
        finalText = [finalText, transcript].filter(Boolean).join(" ").trim();
      } else {
        interimText = [interimText, transcript].filter(Boolean).join(" ").trim();
      }
    }
    state.stt.transcript = finalText;
    state.stt.interim = interimText;
    renderSttTranscript();
  };
  recognition.onerror = (event) => {
    state.stt.listening = false;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      state.stt.shouldKeepAlive = false;
      elements.sttStatus.textContent = "Micro refusé.";
      elements.sttTranscript.textContent = "Le navigateur a refusé l’accès au micro.";
    } else if (event.error === "no-speech") {
      elements.sttStatus.textContent = "J’attends ta voix…";
    } else {
      elements.sttStatus.textContent = "Dictée interrompue.";
    }
    if (!["aborted", "no-speech", "not-allowed", "service-not-allowed"].includes(event.error)) {
      notify("warning", "La dictée vocale a rencontré une erreur.");
    }
  };
  recognition.onend = () => {
    state.stt.listening = false;
    if (elements.sttModal.classList.contains("open") && state.stt.shouldKeepAlive) {
      elements.sttStatus.textContent = state.stt.transcript ? "Je t’écoute encore…" : "J’attends ta voix…";
      state.stt.restartTimerId = window.setTimeout(() => {
        if (elements.sttModal.classList.contains("open") && state.stt.shouldKeepAlive) {
          startSttCapture(SpeechRecognition).catch(() => {
            elements.sttStatus.textContent = "Relance impossible.";
          });
        }
      }, 220);
      return;
    }
    if (elements.sttModal.classList.contains("open")) {
      elements.sttStatus.textContent = state.stt.transcript ? "Dictée terminée." : "Aucune voix détectée.";
    }
  };

  state.stt.recognition = recognition;
  recognition.start();
}

async function stopSttCapture() {
  if (state.stt.restartTimerId) {
    window.clearTimeout(state.stt.restartTimerId);
    state.stt.restartTimerId = null;
  }

  if (state.stt.animationFrameId) {
    cancelAnimationFrame(state.stt.animationFrameId);
    state.stt.animationFrameId = null;
  }

  if (state.stt.recognition) {
    const recognition = state.stt.recognition;
    state.stt.recognition = null;
    try {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    } catch {}
  }

  if (state.stt.source) {
    try {
      state.stt.source.disconnect();
    } catch {}
    state.stt.source = null;
  }

  if (state.stt.stream) {
    for (const track of state.stt.stream.getTracks()) {
      track.stop();
    }
    state.stt.stream = null;
  }

  if (state.stt.audioContext) {
    try {
      await state.stt.audioContext.close();
    } catch {}
    state.stt.audioContext = null;
  }

  state.stt.analyser = null;
  state.stt.listening = false;
  updateSttVisualizer(0.16);
}

function renderSttTranscript() {
  const text = [state.stt.transcript, state.stt.interim].filter(Boolean).join(" ").trim();
  elements.sttTranscript.textContent = text || "Parle pour dicter ton message.";
}

function animateSttVisualizer() {
  if (!state.stt.analyser) {
    updateSttVisualizer(0.2);
    return;
  }

  const buffer = new Uint8Array(state.stt.analyser.frequencyBinCount);
  const tick = () => {
    if (!state.stt.analyser) {
      return;
    }
    state.stt.analyser.getByteFrequencyData(buffer);
    const average = buffer.reduce((sum, value) => sum + value, 0) / (buffer.length * 255 || 1);
    if (average > 0.08 && !state.stt.audioDetected) {
      state.stt.audioDetected = true;
      if (!state.stt.transcript && !state.stt.interim) {
        elements.sttStatus.textContent = "Voix détectée… transcription en attente.";
      }
    }
    updateSttVisualizer(0.18 + average * 1.4);
    state.stt.animationFrameId = requestAnimationFrame(tick);
  };
  tick();
}

function updateSttVisualizer(level) {
  const bars = elements.sttLevelMeter ? [...elements.sttLevelMeter.querySelectorAll(".stt-bar")] : [];
  bars.forEach((bar, index) => {
    const swing = ((index % 2 === 0 ? 0.08 : 0.18) * (index + 1)) / 10;
    const scale = Math.max(0.22, Math.min(1.7, level + swing));
    bar.style.setProperty("--bar-scale", String(scale));
  });
}

async function insertSttTranscript() {
  const text = [state.stt.transcript, state.stt.interim].filter(Boolean).join(" ").trim();
  if (!text) {
    notify("warning", "Aucun texte dicté.");
    return;
  }

  const current = elements.messageInput.value.trim();
  elements.messageInput.value = current ? `${current}\n${text}` : text;
  autoResizeMessageInput();
  await closeSttModal();
  elements.messageInput.focus();
  notify("success", "Texte dicté inséré.");
}

function renderPromptList() {
  const prompts = state.settings.prompts || [];
  if (!prompts.length) {
    elements.promptList.innerHTML = `
      <div class="empty-state-panel compact prompt-empty">
        <i class="bi bi-lightning-charge" aria-hidden="true"></i>
        <p class="empty-state">Aucun prompt enregistré.</p>
        <small>Crée des raccourcis pour tes demandes récurrentes.</small>
      </div>
    `;
    return;
  }

  elements.promptList.innerHTML = prompts
    .map((prompt) => {
      const preview = escapeHtml(prompt.text).replace(/\n/g, " ");
      const locked = isLockedPrompt(prompt);
      const lockedClass = locked ? " is-disabled" : "";
      const lockedAttr = locked ? " disabled aria-disabled=\"true\"" : "";
      return `
        <article class="prompt-item" data-prompt-id="${escapeHtml(prompt.id)}">
          <div class="prompt-copy">
            <strong title="${escapeHtml(prompt.name)}">${escapeHtml(prompt.name)}</strong>
            <p title="${escapeHtml(prompt.text)}">${preview}</p>
          </div>
          <div class="prompt-item-actions">
            <button class="session-action icon-button plain-button" type="button" data-prompt-action="use" data-prompt-id="${escapeHtml(prompt.id)}" aria-label="Utiliser ${escapeHtml(prompt.name)}">
              <i class="bi bi-arrow-return-left icon-glyph" aria-hidden="true"></i>
            </button>
            <button class="session-action icon-button plain-button${lockedClass}" type="button" data-prompt-action="edit" data-prompt-id="${escapeHtml(prompt.id)}" aria-label="Modifier ${escapeHtml(prompt.name)}"${lockedAttr}>
              <i class="bi bi-pencil-fill icon-glyph" aria-hidden="true"></i>
            </button>
            <button class="session-action icon-button plain-button${lockedClass}" type="button" data-prompt-action="delete" data-prompt-id="${escapeHtml(prompt.id)}" aria-label="Supprimer ${escapeHtml(prompt.name)}"${lockedAttr}>
              <i class="bi bi-trash3-fill icon-glyph" aria-hidden="true"></i>
            </button>
          </div>
        </article>
      `;
    })
    .join("");

  for (const button of elements.promptList.querySelectorAll("[data-prompt-action]")) {
    button.addEventListener("click", () => {
      const promptId = button.dataset.promptId;
      const action = button.dataset.promptAction;
      if (action === "use") {
        usePrompt(promptId);
        return;
      }
      if (action === "edit") {
        startEditPrompt(promptId);
        return;
      }
      if (action === "delete") {
        requestDeletePrompt(promptId);
      }
    });
  }
}

function resetPromptForm() {
  state.editingPromptId = null;
  elements.promptForm.reset();
  elements.promptEditorModalTitle.textContent = "Nouveau prompt";
  elements.savePromptButton.textContent = "Enregistrer";
}

function startEditPrompt(promptId) {
  const prompt = (state.settings.prompts || []).find((item) => item.id === promptId);
  if (!prompt) {
    notify("error", "Prompt introuvable.");
    return;
  }
  if (isLockedPrompt(prompt)) {
    notify("info", "Ce prompt par défaut ne peut pas être modifié.");
    return;
  }
  state.editingPromptId = promptId;
  elements.promptNameInput.value = prompt.name || "";
  elements.promptTextInput.value = prompt.text || "";
  elements.promptEditorModalTitle.textContent = "Modifier le prompt";
  elements.savePromptButton.textContent = "Mettre à jour";
  openPromptEditorModal();
}

function usePrompt(promptId) {
  const prompt = (state.settings.prompts || []).find((item) => item.id === promptId);
  if (!prompt) {
    notify("error", "Prompt introuvable.");
    return;
  }
  elements.messageInput.value = prompt.text || "";
  autoResizeMessageInput();
  closePromptModal();
  elements.messageInput.focus();
  notify("success", "Prompt inséré.");
}

function requestDeletePrompt(promptId) {
  const prompt = (state.settings.prompts || []).find((item) => item.id === promptId);
  if (!prompt) {
    notify("error", "Prompt introuvable.");
    return;
  }
  if (isLockedPrompt(prompt)) {
    notify("info", "Ce prompt par défaut ne peut pas être supprimé.");
    return;
  }
  openDeleteModal({
    title: "Supprimer le prompt",
    text: `Supprimer le prompt rapide "${prompt.name}" ?`,
    onConfirm: async () => deletePrompt(promptId),
  });
}

function deletePrompt(promptId) {
  const prompt = (state.settings.prompts || []).find((item) => item.id === promptId);
  if (!prompt) {
    notify("error", "Prompt introuvable.");
    return false;
  }
  const prompts = (state.settings.prompts || []).filter((item) => item.id !== promptId);
  state.settings.prompts = prompts;
  if (state.editingPromptId === promptId) {
    resetPromptForm();
  }
  persistSettings();
  renderPromptList();
  notify("success", "Prompt supprimé.");
  return true;
}

function onSavePrompt(event) {
  event.preventDefault();
  const name = elements.promptNameInput.value.trim();
  const text = elements.promptTextInput.value.trim();

  if (!name || !text) {
    notify("warning", "Nom et prompt sont requis.");
    return;
  }

  const prompts = [...(state.settings.prompts || [])];
  if (state.editingPromptId) {
    const index = prompts.findIndex((item) => item.id === state.editingPromptId);
    if (index === -1) {
      notify("error", "Prompt introuvable.");
      return;
    }
    prompts[index] = { ...prompts[index], name, text };
    notify("success", "Prompt mis à jour.");
  } else {
    prompts.unshift({ id: generateId(), name, text });
    notify("success", "Prompt enregistré.");
  }

  state.settings.prompts = prompts;
  persistSettings();
  renderPromptList();
  resetPromptForm();
  closePromptEditorModal();
}

function renderImageManager() {
  if (state.imagePickerBusy) {
    elements.imageManagerList.innerHTML = `<div class="image-empty image-loading">Ajout des pièces jointes...</div>`;
    return;
  }

  if (!state.pendingAttachments.length) {
    elements.imageManagerList.innerHTML = `
      <div class="empty-state-panel compact image-empty">
        <i class="bi bi-paperclip" aria-hidden="true"></i>
        <p class="empty-state">Aucune pièce jointe.</p>
        <small>Ajoute une ou plusieurs pièces jointes pour le prochain message.</small>
      </div>
    `;
    return;
  }

  elements.imageManagerList.innerHTML = state.pendingAttachments
    .map((attachment) => {
      const safeName = escapeHtml(attachment.name || "attachment");
      const subtitle = attachment.isImage
        ? "Image"
        : escapeHtml(formatAttachmentType(attachment.mimeType));
      const uploadState = attachment.uploadError
        ? '<span class="attachment-upload-state error">Échec upload</span>'
        : attachment.uploading
        ? '<span class="attachment-upload-state">Upload…</span>'
        : '<span class="attachment-upload-state ok">Prêt</span>';
      return `
        <article class="image-card" data-image-id="${escapeHtml(attachment.id)}">
          ${
            attachment.isImage
              ? `<img class="image-preview" src="${escapeHtml(attachment.dataUrl)}" alt="${safeName}" />`
              : `
                <div class="file-preview" aria-hidden="true">
                  <i class="bi ${escapeHtml(pickAttachmentIcon(attachment.mimeType, attachment.name))}"></i>
                </div>
              `
          }
          <div class="image-card-footer">
            <div class="attachment-copy">
              <span class="image-name" title="${safeName}">${safeName}</span>
              <span class="attachment-meta">${subtitle}</span>
              ${uploadState}
            </div>
            <button class="icon-button plain-button image-remove-button" type="button" data-remove-image="${escapeHtml(attachment.id)}" aria-label="Retirer ${safeName}">
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
  closeCreateModal();
  closeConfigModal();
  closeSecretsModal();
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

function openDeleteModal({ title = "Confirmation", text = "", confirmLabel = "Supprimer", onConfirm } = {}) {
  closeMenuDrawer();
  closeCreateModal();
  closeConfigModal();
  closeRenameModal();
  state.pendingDeleteAction = typeof onConfirm === "function" ? onConfirm : null;
  elements.deleteModalTitle.textContent = title;
  elements.deleteModalText.textContent = text;
  elements.confirmDeleteButton.textContent = confirmLabel;
  elements.deleteModal.classList.add("open");
  elements.deleteModal.setAttribute("aria-hidden", "false");
}

function closeDeleteModal() {
  state.pendingDeleteAction = null;
  elements.deleteModal.classList.remove("open");
  elements.deleteModal.setAttribute("aria-hidden", "true");
}

function openDeleteSessionModal(session) {
  openDeleteModal({
    title: "Supprimer la session",
    text: `Supprimer la session "${session.name || session.workspaceName}" ?`,
    onConfirm: async () => deleteSession(session.id),
  });
}

function toggleSidebar() {
  closeMenuDrawer();
  elements.sidebar.classList.toggle("open");
}

function closeSidebar() {
  elements.sidebar.classList.remove("open");
}

function toggleMenuDrawer() {
  closeSidebar();
  elements.menuDrawer.classList.toggle("open");
}

function closeMenuDrawer() {
  elements.menuDrawer.classList.remove("open");
}

async function exportActiveSession() {
  closeMenuDrawer();
  const session = getActiveSession();
  if (!state.activeSessionId || !session) {
    notify("warning", "Aucune session active à exporter.");
    return;
  }

  const response = await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/export`);
  if (!response.ok) {
    notify("error", "Export impossible.");
    return;
  }

  const payload = await response.json();
  const sessionName = slugifyFileName(payload?.session?.name || "session");
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sessionName || "session"}.json`;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 1000);
  notify("success", "Session exportée.");
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

  const response = await apiFetch("/api/config/codex", {
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
  state.manualScrollLockUntil = Date.now() + 1200;
  enforceConversationScroll(0);
  updateScrollDockVisibility();
}

function scrollConversationBottom() {
  state.manualScrollLockUntil = 0;
  enforceConversationScroll(elements.messages.scrollHeight);
  updateScrollDockVisibility();
}

function enforceConversationScroll(top) {
  elements.messages.scrollTo({ top, behavior: "smooth" });
  elements.messages.scrollTop = top;
  window.requestAnimationFrame(() => {
    elements.messages.scrollTop = top;
  });
  window.setTimeout(() => {
    elements.messages.scrollTop = top;
  }, 0);
}

function hasConversation() {
  return state.messages.length > 0;
}

function updateScrollDockVisibility() {
  const shouldShow = hasConversation() && elements.messages.scrollHeight - elements.messages.clientHeight > 24;
  elements.scrollDock.classList.toggle("visible", shouldShow);
  elements.scrollDock.setAttribute("aria-hidden", shouldShow ? "false" : "true");
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

  const response = await apiFetch(`/api/sessions/${encodeURIComponent(state.pendingRenameSessionId)}`, {
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

async function deleteSession(sessionId) {
  if (!sessionId) {
    return false;
  }

  const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    notify("error", "Suppression impossible.");
    return false;
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

  notify("success", "Session supprimee.");
  return true;
}

async function onConfirmDelete() {
  if (typeof state.pendingDeleteAction !== "function") {
    return;
  }
  const completed = await state.pendingDeleteAction();
  if (completed !== false) {
    closeDeleteModal();
  }
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

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fallback below for insecure contexts and older mobile browsers.
    }
  }

  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.top = "-9999px";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.focus();
  helper.select();
  helper.setSelectionRange(0, helper.value.length);

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("copy failed");
    }
  } finally {
    helper.remove();
  }
}

async function copyMessageToClipboard(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) {
    notify("error", "Message introuvable.");
    return;
  }

  const content = String(message.text || (message.pending ? "Codex réfléchit" : "")).trim();
  if (!content) {
    notify("warning", "Rien à copier.");
    return;
  }

  try {
    await writeClipboardText(content);
    notify("success", "Message copié.");
  } catch (error) {
    notify("error", "Copie impossible.");
  }
}

function notify(type, text) {
  const id = generateId();
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

function slugifyFileName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-");
}

async function onPickImages(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) {
    return;
  }

  if (!state.activeSessionId) {
    elements.imageInput.value = "";
    notify("warning", "Selectionne d'abord une session.");
    return;
  }

  state.imagePickerBusy = true;
  renderImageManager();

  const images = [];
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    images.push({
      id: generateId(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      dataUrl,
      isImage: String(file.type || "").startsWith("image/"),
      uploading: true,
      uploadError: false,
    });
  }

  state.imagePickerBusy = false;
  state.pendingAttachments.push(...images);
  elements.imageInput.value = "";
  renderImageManager();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);

  await Promise.all(images.map((attachment) => uploadDraftAttachment(attachment)));
  renderImageManager();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);
  const successCount = images.filter((attachment) => !attachment.uploadError).length;
  if (successCount) {
    notify("success", `${successCount} pièce${successCount > 1 ? "s" : ""} jointe${successCount > 1 ? "s" : ""} prête${successCount > 1 ? "s" : ""}.`);
  }
  if (images.some((attachment) => attachment.uploadError)) {
    notify("warning", "Certaines pièces jointes n'ont pas pu être envoyées.");
  }
}

async function retryLastUserMessage() {
  if (!state.activeSessionId) {
    notify("warning", "Aucune session active.");
    return;
  }

  if (isActiveSessionRunning()) {
    notify("info", "Codex est deja en train de repondre.");
    return;
  }

  const response = await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/retry`, {
    method: "POST",
  });

  if (response.status === 400) {
    notify("info", "Aucun message utilisateur à relancer.");
    return;
  }
  if (response.status === 409) {
    notify("info", "Codex est deja en train de repondre.");
    return;
  }
  if (!response.ok) {
    notify("error", "Relance impossible.");
    return;
  }

  const payload = await response.json();
  if (state.activeSessionId === payload.session?.id) {
    state.messages = Array.isArray(payload.messages) ? payload.messages : state.messages;
    upsertSessionSummary(payload.session);
    updateHeader(payload.session);
    renderMessages(true);
  }

  notify("success", "Tour relancé.");
}

function clearComposer() {
  elements.messageInput.value = "";
  autoResizeMessageInput();
  void clearPendingImages();
}

function resetComposerState() {
  elements.messageInput.value = "";
  elements.imageInput.value = "";
  state.imagePickerBusy = false;
  state.pendingAttachments = [];
  renderImageManager();
  autoResizeMessageInput();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);
}

async function clearPendingImages() {
  state.imagePickerBusy = false;
  const attachments = [...state.pendingAttachments];
  for (const attachment of attachments) {
    attachment.removed = true;
  }
  state.pendingAttachments = [];
  elements.imageInput.value = "";
  await Promise.all(attachments.map((attachment) => deleteDraftAttachment(attachment)));
  renderImageManager();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);
}

async function removePendingImage(imageId) {
  const target = state.pendingAttachments.find((image) => image.id === imageId);
  state.pendingAttachments = state.pendingAttachments.filter((image) => image.id !== imageId);
  if (target) {
    target.removed = true;
    await deleteDraftAttachment(target);
  }
  renderImageManager();
  renderComposerStatus(state.bootstrap?.sessions?.find((item) => item.id === state.activeSessionId) || null);
}

function buildComposerStatus(session, running = Boolean(session) && isActiveSessionRunning()) {
  let base = "Aucune session";
  if (session) {
    if (running) {
      base = "Réponse en cours";
    } else if (session.status === "interrupted") {
      base = "Interrompu";
    } else if (session.status === "error") {
      base = "Erreur";
    } else {
      base = "Prêt";
    }
  }
  if (!state.pendingAttachments.length) {
    return base;
  }
  const pendingUploads = state.pendingAttachments.filter((attachment) => attachment.uploading).length;
  const failedUploads = state.pendingAttachments.filter((attachment) => attachment.uploadError).length;
  if (pendingUploads) {
    return `Upload en cours · ${pendingUploads}`;
  }
  if (failedUploads) {
    return `Upload incomplet · ${failedUploads}`;
  }
  return `${base} · ${state.pendingAttachments.length} pièce${state.pendingAttachments.length > 1 ? "s" : ""}`;
}

async function uploadDraftAttachment(attachment) {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataUrl: attachment.dataUrl,
    }),
  });

  if (!response.ok) {
    attachment.uploading = false;
    attachment.uploadError = true;
    return;
  }

  const payload = await response.json();
  attachment.uploading = false;
  attachment.uploadError = false;
  attachment.draftId = payload.attachment?.draftId || attachment.id;
  attachment.path = payload.attachment?.path || "";
  attachment.relativePath = payload.attachment?.relativePath || "";
  if (attachment.removed || !state.pendingAttachments.some((item) => item.id === attachment.id)) {
    await deleteDraftAttachment(attachment);
  }
}

async function deleteDraftAttachment(attachment) {
  if (!state.activeSessionId || !attachment?.draftId) {
    return;
  }
  await apiFetch(
    `/api/sessions/${encodeURIComponent(state.activeSessionId)}/attachments/${encodeURIComponent(attachment.draftId)}`,
    { method: "DELETE" }
  ).catch(() => null);
}

function formatAttachmentType(mimeType) {
  if (!mimeType) {
    return "Fichier";
  }
  if (mimeType.startsWith("image/")) {
    return "Image";
  }
  if (mimeType === "application/pdf") {
    return "PDF";
  }
  if (mimeType.startsWith("text/")) {
    return "Texte";
  }
  if (mimeType.includes("zip")) {
    return "Archive";
  }
  return "Fichier";
}

function pickAttachmentIcon(mimeType, name = "") {
  const lowerName = String(name).toLowerCase();
  if (String(mimeType || "").startsWith("image/")) {
    return "bi-image-fill";
  }
  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    return "bi-filetype-pdf";
  }
  if (mimeType.startsWith("text/") || /\.(md|txt|json|yaml|yml|xml|csv|log)$/i.test(lowerName)) {
    return "bi-file-earmark-text-fill";
  }
  if (/\.(zip|tar|gz|tgz|rar|7z)$/i.test(lowerName) || String(mimeType || "").includes("zip")) {
    return "bi-file-earmark-zip-fill";
  }
  return "bi-file-earmark-fill";
}

function renderComposerStatus(session, running = Boolean(session) && isActiveSessionRunning()) {
  const status = running ? "running" : session?.status || "idle";
  const label = escapeHtml(buildComposerStatus(session, running));
  const loading = status === "running" ? '<span class="loading-inline loading-inline-sm" aria-hidden="true"></span>' : "";
  elements.composerStatus.innerHTML = `${loading}<span class="composer-status-text">${label}</span>`;
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
  const theme = normalizeTheme(elements.themeValueInput.value || elements.themeSelect.value || state.settings.theme);
  const seconds = clampDuration(elements.notificationDurationInput.value);
  const workspaceRoot = String(elements.workspaceRootInput.value || "").trim() || "/projects";
  const payload = {
    model: state.codexConfig.model,
    sandboxDangerFullAccess: elements.sandboxDangerInput.checked,
    approvalNever: elements.approvalNeverInput.checked,
    hideFullAccessWarning: elements.hideFullAccessWarningInput.checked,
    search: elements.searchInput.checked,
  };

  const appResponse = await apiFetch("/api/config/app", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceRoot }),
  });

  if (!appResponse.ok) {
    notify("error", "Mise a jour du dossier racine impossible.");
    return;
  }

  const codexResponse = await apiFetch("/api/config/codex", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!codexResponse.ok) {
    notify("error", "Mise a jour de la configuration Codex impossible.");
    await refreshAppConfig();
    await refreshBootstrap();
    return;
  }

  const appConfigPayload = await appResponse.json();
  state.appConfig = {
    workspaceRoot: appConfigPayload.workspaceRoot || "/projects",
  };
  state.codexConfig = await codexResponse.json();

  state.settings.theme = theme;
  state.settings.notificationDurationSeconds = seconds;
  await persistSettings({ lastSessionId: state.activeSessionId });
  applyTheme(theme);
  await refreshBootstrap();
  const targetSessionId = pickSessionId();
  if (targetSessionId) {
    await activateSession(targetSessionId);
  } else {
    disconnectSocket();
    state.activeSessionId = null;
    state.messages = [];
    renderSessionList();
    updateHeader(null);
    renderMessages();
  }
  closeConfigModal();
  notify("success", `Configuration enregistree. Notifications a ${seconds}s.`);
}

async function onSaveSecret(event) {
  event.preventDefault();
  const type = elements.secretTypeInput.value === "credentials" ? "credentials" : "value";
  const key = String(elements.secretKeyInput.value || "").trim().toUpperCase();
  const value = String(elements.secretValueInput.value || "");
  const identifier = String(elements.secretIdentifierInput.value || "");
  const password = String(elements.secretPasswordInput.value || "");

  if (!key) {
    notify("warning", "Clé de secret requise.");
    return;
  }

  const editing = Boolean(state.editingSecretKey);
  const endpoint = editing
    ? `/api/secrets/${encodeURIComponent(state.editingSecretKey)}`
    : "/api/secrets";
  const method = editing ? "PATCH" : "POST";
  const response = await apiFetch(endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, type, value, identifier, password }),
  });

  if (response.status === 400) {
    notify("warning", "Secret invalide.");
    return;
  }
  if (response.status === 403) {
    notify("error", "Ce secret est protégé.");
    return;
  }
  if (!response.ok) {
    notify("error", "Enregistrement du secret impossible.");
    return;
  }

  await refreshSecrets();
  renderSecretsList();
  closeSecretEditorModal();
  notify("success", editing ? "Secret mis à jour." : "Secret ajouté.");
}

function requestDeleteSecret(key) {
  const secret = state.secrets.find((item) => item.key === key);
  if (!secret) {
    notify("error", "Secret introuvable.");
    return;
  }
  openDeleteModal({
    title: "Supprimer le secret",
    text: `Supprimer le secret "${secret.key}" ?`,
    onConfirm: async () => deleteSecret(secret.key),
  });
}

async function deleteSecret(key) {
  if (!key) {
    return false;
  }
  const response = await apiFetch(`/api/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  if (response.status === 403) {
    notify("error", "Ce secret est protégé.");
    return false;
  }
  if (!response.ok) {
    notify("error", "Suppression du secret impossible.");
    return false;
  }
  await refreshSecrets();
  renderSecretsList();
  notify("success", "Secret supprimé.");
  return true;
}

function defaultSettings() {
  return { theme: "sandstone", notificationDurationSeconds: 5, prompts: withDefaultQuickPrompts([]) };
}

function normalizeSettings(payload = {}) {
  const prompts = Array.isArray(payload.prompts)
    ? payload.prompts
        .filter((item) => item && typeof item.name === "string" && typeof item.text === "string")
        .map((item) => ({
          id: typeof item.id === "string" && item.id ? item.id : generateId(),
          name: item.name.trim(),
          text: item.text.trim(),
          locked: Boolean(item.locked),
        }))
        .filter((item) => item.name && item.text)
    : [];

  return {
    theme: normalizeTheme(payload.theme),
    notificationDurationSeconds: clampDuration(payload.notificationDurationSeconds),
    prompts: withDefaultQuickPrompts(prompts),
  };
}

function persistSettings({ lastSessionId } = {}) {
  const payload = {
    theme: state.settings.theme,
    notificationDurationSeconds: state.settings.notificationDurationSeconds,
    prompts: state.settings.prompts,
  };

  if (typeof lastSessionId !== "undefined") {
    payload.lastSessionId = lastSessionId;
  }

  settingsSavePromise = settingsSavePromise
    .catch(() => {})
    .then(async () => {
      const response = await apiFetch("/api/ui-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error("Sauvegarde de l'état d'interface impossible.");
      }
      const saved = await response.json();
      state.settings = normalizeSettings(saved);
    })
    .catch((error) => {
      console.warn(error);
    });

  return settingsSavePromise;
}

function withDefaultQuickPrompts(prompts) {
  const merged = [...prompts];
  for (const item of defaultQuickPrompts) {
    const index = merged.findIndex((prompt) => prompt.name.trim().toLowerCase() === item.name.trim().toLowerCase());
    if (index === -1) {
      merged.push({ id: generateId(), ...item });
      continue;
    }
    merged[index] = { ...merged[index], locked: Boolean(item.locked) };
  }
  return merged;
}

function isLockedPrompt(prompt) {
  return Boolean(prompt?.locked);
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
