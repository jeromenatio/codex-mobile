import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import AdmZip from "adm-zip";
import DatabaseSync from "better-sqlite3";

const TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-mobile-auth-"));
const PORT = 4600 + Math.floor(Math.random() * 500);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(TMP_ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "codex-mobile.sqlite");
const WORKSPACE_ROOT = path.join(TMP_ROOT, "workspaces");
const CONFIG_FILE = path.join(TMP_ROOT, "codex-config.toml");
const MODELS_CACHE_FILE = path.join(TMP_ROOT, "models-cache.json");
const ENV_FILE = path.join(TMP_ROOT, "codex-mobile.env");
const SESSION_CONTEXT_FILE = path.join(TMP_ROOT, "session-context.md");
const RUNTIME_SOCKET_FILE = path.join(TMP_ROOT, "runtime.sock");
const RUNTIME_STATE_FILE = path.join(TMP_ROOT, "runtime-state.json");
const RUNTIME_PID_FILE = path.join(TMP_ROOT, "runtime.pid");
const AUTH_TOKEN = "test-auth-token";
const INITIAL_GITHUB_TOKEN = "ghp_initial_test_token";

let serverProcess;

test("auth et configuration app", async () => {
  await startServer();

  try {
    let response = await fetch(`${BASE_URL}/api/bootstrap`);
    assert.equal(response.status, 401);

    response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    assert.equal(response.status, 401);

    response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: AUTH_TOKEN }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie || "", /codex_mobile_auth=/);

    response = await fetch(`${BASE_URL}/api/config/app`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const initialConfig = await response.json();
    assert.equal(initialConfig.workspaceRoot, WORKSPACE_ROOT);
    assert.equal(initialConfig.telegram.enabled, false);

    response = await fetch(`${BASE_URL}/api/config/app`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        workspaceRoot: WORKSPACE_ROOT,
        telegram: {
          enabled: true,
          webhookSecret: "telegram-webhook-secret",
          botTokenSecretKey: "TELEGRAM_BOT_TOKEN",
          allowedChatIds: "123456789",
          workspace: "telegram-test",
        },
      }),
    });
    assert.equal(response.status, 200);
    const telegramConfig = await response.json();
    assert.equal(telegramConfig.telegram.enabled, true);
    assert.equal(telegramConfig.telegram.workspace, "telegram-test");

    response = await fetch(`${BASE_URL}/webhooks/telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "telegram-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 1001,
        message: {
          message_id: 10,
          from: {
            id: 123456789,
            first_name: "Alice",
          },
          chat: {
            id: 123456789,
            type: "private",
          },
          text: "bonjour depuis telegram",
        },
      }),
    });
    assert.equal(response.status, 200);

    const outboxFile = path.join(DATA_DIR, "telegram-outbox.json");
    let telegramReply = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const outbox = JSON.parse(await fsp.readFile(outboxFile, "utf8"));
        telegramReply = outbox.find((item) => item.chat_id === "123456789");
      } catch {}
      if (telegramReply) {
        break;
      }
      await delay(150);
    }
    assert.equal(Boolean(telegramReply), true);
    assert.match(telegramReply.text, /bonjour depuis telegram/);

    response = await fetch(`${BASE_URL}/api/ui-state`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const initialUiState = await response.json();
    assert.equal(initialUiState.theme, "sandstone");
    assert.equal(initialUiState.notificationDurationSeconds, 5);
    assert.equal(Array.isArray(initialUiState.prompts), true);
    assert.match(initialUiState.prompts.map((item) => item.name).join(" | "), /Commit & push/);

    const nextRoot = path.join(TMP_ROOT, "workspaces-alt");
    response = await fetch(`${BASE_URL}/api/config/app`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ workspaceRoot: nextRoot }),
    });
    assert.equal(response.status, 200);
    const updatedConfig = await response.json();
    assert.equal(updatedConfig.workspaceRoot, nextRoot);
    assert.equal(fs.existsSync(nextRoot), true);

    response = await fetch(`${BASE_URL}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ workspace: "alt-root-suite", prompt: "" }),
    });
    assert.equal(response.status, 201);
    const altRootSession = await response.json();
    assert.equal(altRootSession.session.workspaceName, "alt-root-suite");

    response = await fetch(`${BASE_URL}/api/bootstrap`, {
      headers: { cookie },
    });
    let bootstrap = await response.json();
    assert.equal(bootstrap.sessions.some((item) => item.workspaceName === "alt-root-suite"), true);
    assert.equal(bootstrap.sessions.some((item) => item.workspaceName === "api-suite"), false);

    response = await fetch(`${BASE_URL}/api/config/app`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ workspaceRoot: WORKSPACE_ROOT }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${BASE_URL}/api/bootstrap`, {
      headers: { cookie },
    });
    bootstrap = await response.json();
    assert.equal(bootstrap.sessions.some((item) => item.workspaceName === "alt-root-suite"), false);

    response = await fetch(`${BASE_URL}/api/ui-state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        theme: "arctic-glass",
        notificationDurationSeconds: 9,
        lastSessionId: "session-test-id",
        prompts: [
          ...initialUiState.prompts,
          {
            id: "custom-prompt-id",
            name: "Résumé",
            text: "Fais un résumé concis.",
            locked: false,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const updatedUiState = await response.json();
    assert.equal(updatedUiState.theme, "arctic-glass");
    assert.equal(updatedUiState.notificationDurationSeconds, 9);
    assert.equal(updatedUiState.lastSessionId, "session-test-id");
    assert.match(updatedUiState.prompts.map((item) => item.name).join(" | "), /Résumé/);

    response = await fetch(`${BASE_URL}/api/secrets`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const listedSecrets = await response.json();
    assert.equal(Array.isArray(listedSecrets.secrets), true);
    assert.equal(listedSecrets.secrets.some((item) => item.key === "GITHUB_TOKEN"), true);
    const authTokenSecret = listedSecrets.secrets.find((item) => item.key === "CODEX_MOBILE_AUTH_TOKEN");
    assert.equal(Boolean(authTokenSecret), true);
    assert.equal(authTokenSecret?.protected, true);
    assert.equal(authTokenSecret?.canDelete, false);
    assert.equal(authTokenSecret?.canEditKey, false);

    response = await fetch(`${BASE_URL}/api/secrets/CODEX_MOBILE_AUTH_TOKEN`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ key: "CODEX_MOBILE_AUTH_TOKEN", value: "updated-auth-token" }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${BASE_URL}/api/secrets/CODEX_MOBILE_AUTH_TOKEN`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ key: "RENAMED_AUTH_TOKEN", value: "forbidden" }),
    });
    assert.equal(response.status, 403);

    response = await fetch(`${BASE_URL}/api/secrets/CODEX_MOBILE_AUTH_TOKEN`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(response.status, 403);

    const nextGithubToken = "ghp_updated_test_token";
    response = await fetch(`${BASE_URL}/api/secrets/GITHUB_TOKEN`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ key: "GITHUB_TOKEN", value: nextGithubToken }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${BASE_URL}/api/secrets/GITHUB_TOKEN`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ key: "GITHUB_TOKEN", value: "" }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${BASE_URL}/api/secrets`, {
      headers: { cookie },
    });
    const preservedSecrets = await response.json();
    assert.equal(preservedSecrets.secrets.some((item) => item.key === "GITHUB_TOKEN"), true);

    response = await fetch(`${BASE_URL}/api/secrets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ key: "OVH_TOKEN", value: "ovh-secret-value" }),
    });
    assert.equal(response.status, 201);

    response = await fetch(`${BASE_URL}/api/secrets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ key: "HETZNER", type: "credentials", identifier: "hz-id", password: "hz-pass" }),
    });
    assert.equal(response.status, 201);

    response = await fetch(`${BASE_URL}/api/secrets`, {
      headers: { cookie },
    });
    const mixedSecrets = await response.json();
    const hetzner = mixedSecrets.secrets.find((item) => item.key === "HETZNER");
    assert.equal(hetzner?.type, "credentials");

    response = await fetch(`${BASE_URL}/api/secrets/OVH_TOKEN`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(response.status, 200);

    response = await fetch(`${BASE_URL}/api/secrets/HETZNER`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ key: "HETZNER", type: "credentials", identifier: "", password: "hz-pass-2" }),
    });
    assert.equal(response.status, 200);

    const envText = await fsp.readFile(ENV_FILE, "utf8");
    assert.match(envText, /^GITHUB_TOKEN=ghp_updated_test_token$/m);
    assert.match(envText, /^CODEX_MOBILE_AUTH_TOKEN=updated-auth-token$/m);
    assert.doesNotMatch(envText, /^OVH_TOKEN=/m);
    assert.match(envText, /^HETZNER_ID=hz-id$/m);
    assert.match(envText, /^HETZNER_PASSWORD=hz-pass-2$/m);

    response = await fetch(`${BASE_URL}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ workspace: "api-suite", prompt: "" }),
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.session.workspaceName, "api-suite");

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/git-status`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    let gitStatus = await response.json();
    assert.equal(gitStatus.git.level, "down");

    await runProcess("git", ["init"], { cwd: created.session.workspacePath });
    await runProcess("git", ["config", "user.name", "Codex Mobile Test"], { cwd: created.session.workspacePath });
    await runProcess("git", ["config", "user.email", "tests@example.com"], { cwd: created.session.workspacePath });
    await fsp.writeFile(path.join(created.session.workspacePath, "README.md"), "# api-suite\n", "utf8");
    await runProcess("git", ["add", "README.md"], { cwd: created.session.workspacePath });
    await runProcess("git", ["commit", "-m", "Initial commit"], { cwd: created.session.workspacePath });
    await runProcess("git", ["branch", "-M", "main"], { cwd: created.session.workspacePath });

    const githubRemotePath = path.join(TMP_ROOT, "github.com-api-suite.git");
    await runProcess("git", ["init", "--bare", githubRemotePath], { cwd: TMP_ROOT });
    await runProcess("git", ["remote", "add", "origin", githubRemotePath], { cwd: created.session.workspacePath });
    await runProcess("git", ["push", "-u", "origin", "main"], { cwd: created.session.workspacePath });
    await delay(1200);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/git-status`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    gitStatus = await response.json();
    assert.equal(gitStatus.git.level, "ok");

    await fsp.writeFile(path.join(created.session.workspacePath, "README.md"), "# api-suite\n\nchange local\n", "utf8");
    await delay(1200);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/git-status`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    gitStatus = await response.json();
    assert.equal(gitStatus.git.level, "warn");

    response = await fetch(`${BASE_URL}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ workspace: "context-suite", prompt: "" }),
    });
    assert.equal(response.status, 201);
    const contextSession = await response.json();

    response = await fetch(`${BASE_URL}/api/sessions/${contextSession.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ text: "__SLOW__ first", attachments: [] }),
    });
    assert.equal(response.status, 200);

    let firstPrompt = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let state = { runs: [] };
      try {
        state = JSON.parse(await fsp.readFile(RUNTIME_STATE_FILE, "utf8"));
      } catch {}
      const run = Array.isArray(state.runs) ? state.runs.find((entry) => entry.sessionId === contextSession.session.id) : null;
      firstPrompt = String(run?.prompt || "");
      if (firstPrompt) {
        break;
      }
      await delay(100);
    }
    assert.match(firstPrompt, /SESSION_CONTEXT_MARKER/);
    assert.match(firstPrompt, /context-suite/);
    assert.match(firstPrompt, /\/etc\/codex-mobile\/\.env/);
    assert.match(firstPrompt, /GITHUB_TOKEN/);
    assert.match(firstPrompt, /HETZNER/);
    assert.match(firstPrompt, /Demande utilisateur :/);

    response = await fetch(`${BASE_URL}/api/sessions/${contextSession.session.id}/interrupt`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(response.status, 200);

    let contextInterrupted = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${contextSession.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      const lastMessage = snapshot.session.messages.at(-1);
      if (lastMessage && !lastMessage.pending) {
        contextInterrupted = true;
        break;
      }
      await delay(100);
    }
    assert.equal(contextInterrupted, true);

    response = await fetch(`${BASE_URL}/api/sessions/${contextSession.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ text: "__SLOW__ second", attachments: [] }),
    });
    assert.equal(response.status, 200);

    let secondPrompt = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let state = { runs: [] };
      try {
        state = JSON.parse(await fsp.readFile(RUNTIME_STATE_FILE, "utf8"));
      } catch {}
      const run = Array.isArray(state.runs) ? state.runs.find((entry) => entry.sessionId === contextSession.session.id) : null;
      secondPrompt = String(run?.prompt || "");
      if (secondPrompt.includes("__SLOW__ second")) {
        break;
      }
      await delay(100);
    }
    assert.doesNotMatch(secondPrompt, /SESSION_CONTEXT_MARKER/);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ text: "bonjour", attachments: [] }),
    });
    assert.equal(response.status, 200);
    const sent = await response.json();
    assert.equal(sent.session.id, created.session.id);
    assert.equal(Array.isArray(sent.messages), true);
    assert.equal(sent.messages.length, 2);
    assert.equal(sent.messages[0].role, "user");
    assert.equal(sent.messages[0].text, "bonjour");
    assert.equal(sent.messages[1].role, "assistant");
    assert.equal(sent.messages[1].pending, true);

    let firstTurnComplete = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      if (!snapshot.session.messages.at(-1)?.pending) {
        firstTurnComplete = true;
        break;
      }
      await delay(150);
    }
    assert.equal(firstTurnComplete, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ text: "__BAD_REQUEST_ONCE__", attachments: [] }),
    });
    assert.equal(response.status, 200);

    let badRequestRecovered = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      const lastMessage = snapshot.session.messages.at(-1);
      if (lastMessage && !lastMessage.pending) {
        assert.match(lastMessage.text, /Réponse de test: __BAD_REQUEST_ONCE__/);
        badRequestRecovered = true;
        break;
      }
      await delay(150);
    }
    assert.equal(badRequestRecovered, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ text: "__RATE_LIMIT_ONCE__", attachments: [] }),
    });
    assert.equal(response.status, 200);

    let rateLimitRecovered = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      const lastMessage = snapshot.session.messages.at(-1);
      if (lastMessage && !lastMessage.pending) {
        assert.match(lastMessage.text, /Réponse de test: __RATE_LIMIT_ONCE__/);
        rateLimitRecovered = true;
        break;
      }
      await delay(150);
    }
    assert.equal(rateLimitRecovered, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        id: "draft-notes",
        name: "notes.txt",
        mimeType: "text/plain",
        dataUrl: `data:text/plain;base64,${Buffer.from("bonjour fichier", "utf8").toString("base64")}`,
      }),
    });
    assert.equal(response.status, 201);
    const uploadedDraft = await response.json();

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        text: "avec fichier",
        attachments: [
          {
            draftId: uploadedDraft.attachment.draftId,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const withFile = await response.json();
    assert.equal(withFile.messages.at(-2).text, "avec fichier");
    assert.equal(withFile.messages.at(-2).attachments.length, 1);
    const storedAttachment = withFile.messages.at(-2).attachments[0];
    assert.match(storedAttachment.path, new RegExp(`\\.codex-mobile/uploads/${created.session.id}`));
    assert.match(storedAttachment.relativePath, /^\.codex-mobile\/uploads\//);
    assert.equal(fs.existsSync(storedAttachment.path), true);

    response = await fetch(
      `${BASE_URL}/api/sessions/${created.session.id}/messages/${withFile.messages.at(-2).id}/attachments/${storedAttachment.id}`,
      {
        headers: { cookie },
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "bonjour fichier");

    await fsp.rm(storedAttachment.path, { force: true });
    response = await fetch(
      `${BASE_URL}/api/sessions/${created.session.id}/messages/${withFile.messages.at(-2).id}/attachments/${storedAttachment.id}`,
      {
        headers: { cookie },
      }
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Attachment file not found");

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const cleanedExport = await response.json();
    const cleanedUserMessage = cleanedExport.session.messages.find((message) => message.id === withFile.messages.at(-2).id);
    assert.equal(Array.isArray(cleanedUserMessage?.attachments), true);
    assert.equal(cleanedUserMessage.attachments.length, 0);

    let attachmentTurnComplete = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      if (!snapshot.session.messages.at(-1)?.pending) {
        attachmentTurnComplete = true;
        break;
      }
      await delay(150);
    }
    assert.equal(attachmentTurnComplete, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        id: "draft-pdf",
        name: "bonjour.pdf",
        mimeType: "application/pdf",
        dataUrl: pdfDataUrl("Bonjour PDF"),
      }),
    });
    assert.equal(response.status, 201);
    const uploadedPdf = await response.json();

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        text: "avec pdf",
        attachments: [
          {
            draftId: uploadedPdf.attachment.draftId,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const withPdf = await response.json();
    const storedPdf = withPdf.messages.at(-2).attachments[0];
    assert.equal(storedPdf.mimeType, "application/pdf");
    assert.match(storedPdf.extractedText || "", /Bonjour PDF/);
    assert.equal(Boolean(storedPdf.extractedTextPath), true);
    assert.equal(fs.existsSync(path.join(created.session.workspacePath, storedPdf.extractedTextPath)), true);

    let pdfTurnComplete = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      if (!snapshot.session.messages.at(-1)?.pending) {
        pdfTurnComplete = true;
        break;
      }
      await delay(150);
    }
    assert.equal(pdfTurnComplete, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        id: "draft-zip",
        name: "bundle.zip",
        mimeType: "application/zip",
        dataUrl: zipDataUrl([
          { name: "notes.txt", content: "Bonjour ZIP texte" },
          { name: "docs/bonjour.pdf", content: buildMinimalPdfBuffer("Bonjour ZIP PDF") },
        ]),
      }),
    });
    assert.equal(response.status, 201);
    const uploadedZip = await response.json();

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        text: "avec zip",
        attachments: [
          {
            draftId: uploadedZip.attachment.draftId,
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const withZip = await response.json();
    const storedZip = withZip.messages.at(-2).attachments[0];
    assert.equal(storedZip.mimeType, "application/zip");
    assert.equal(Array.isArray(storedZip.extractedEntries), true);
    assert.equal(storedZip.extractedEntries.some((entry) => /notes\.txt$/i.test(entry.relativePath || "")), true);
    assert.equal(storedZip.extractedEntries.some((entry) => /bonjour\.pdf$/i.test(entry.relativePath || "")), true);
    const extractedTextEntry = storedZip.extractedEntries.find((entry) => /notes\.txt$/i.test(entry.relativePath || ""));
    assert.match(extractedTextEntry?.extractedText || "", /Bonjour ZIP texte/);
    const extractedPdfEntry = storedZip.extractedEntries.find((entry) => /bonjour\.pdf$/i.test(entry.relativePath || ""));
    assert.match(extractedPdfEntry?.extractedText || "", /Bonjour ZIP PDF/);

    let zipTurnComplete = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      if (!snapshot.session.messages.at(-1)?.pending) {
        zipTurnComplete = true;
        break;
      }
      await delay(150);
    }
    assert.equal(zipTurnComplete, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/retry`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const retried = await response.json();
    assert.equal(Array.isArray(retried.messages), true);
    assert.equal(retried.messages.length, 14);
    assert.equal(retried.messages.at(-2).role, "user");
    assert.equal(retried.messages.at(-2).text, "avec zip");
    assert.equal(retried.messages.at(-2).attachments.length, 1);
    assert.equal(retried.messages.at(-1).role, "assistant");
    assert.equal(retried.messages.at(-1).pending, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const exported = await response.json();
    assert.equal(typeof exported.exportedAt, "string");
    assert.equal(exported.session.id, created.session.id);
    assert.equal(exported.session.workspaceName, "api-suite");
    assert.equal(Array.isArray(exported.session.messages), true);
    assert.equal(exported.session.messages.length, 14);
    assert.equal(exported.session.messages[0].text, "bonjour");

    let retryTurnComplete = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      if (!snapshot.session.messages.at(-1)?.pending) {
        retryTurnComplete = true;
        break;
      }
      await delay(150);
    }
    assert.equal(retryTurnComplete, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ text: "__SLOW__", attachments: [] }),
    });
    assert.equal(response.status, 200);
    await delay(300);

    await stopServer({ preserveRuntime: true });
    await startServer();

    response = await fetch(`${BASE_URL}/api/bootstrap`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const resumedBootstrap = await response.json();
    const resumedSession = resumedBootstrap.sessions.find((item) => item.id === created.session.id);
    assert.equal(resumedSession?.status, "running");

    const resumeDeadline = Date.now() + 10000;
    let completedSlowTurn = false;
    while (Date.now() < resumeDeadline) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const resumedExport = await response.json();
      const lastMessage = resumedExport.session.messages.at(-1);
      if (lastMessage && !lastMessage.pending) {
        assert.match(lastMessage.text, /Réponse de test: __SLOW__/);
        completedSlowTurn = true;
        break;
      }
      await delay(200);
    }
    assert.equal(completedSlowTurn, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ text: "__SLOW__", attachments: [] }),
    });
    assert.equal(response.status, 200);
    const slowRunPayload = await response.json();
    const messageCountBeforeRuntimeRestart = slowRunPayload.messages.length;
    await delay(250);

    await stopRuntime();

    let runtimeRecovered = false;
    const recoveryDeadline = Date.now() + 10000;
    while (Date.now() < recoveryDeadline) {
      response = await fetch(`${BASE_URL}/api/health`);
      const health = response.ok ? await response.json() : null;
      if (health?.runtimeOk) {
        runtimeRecovered = true;
        break;
      }
      await delay(150);
    }
    assert.equal(runtimeRecovered, true);

    let recoveredAfterRuntimeRestart = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
        headers: { cookie },
      });
      const snapshot = await response.json();
      const lastMessage = snapshot.session.messages.at(-1);
      if (lastMessage && !lastMessage.pending) {
        assert.match(lastMessage.text, /Réponse de test: __SLOW__/);
        assert.equal(snapshot.session.messages.length, messageCountBeforeRuntimeRestart);
        recoveredAfterRuntimeRestart = true;
        break;
      }
      await delay(150);
    }
    assert.equal(recoveredAfterRuntimeRestart, true);

    const importedWorkspacePath = path.join(WORKSPACE_ROOT, "imported-suite");
    await fsp.mkdir(importedWorkspacePath, { recursive: true });
    const rolloutPath = path.join(importedWorkspacePath, "imported-rollout.jsonl");
    const threadId = "thread-imported-refresh";
    await fsp.writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:00.000Z",
          payload: { type: "user_message", message: "question initiale" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:01.000Z",
          payload: { type: "agent_message", phase: "final_answer", message: "réponse initiale" },
        }),
      ].join("\n"),
      "utf8"
    );

    {
      const db = new DatabaseSync(DB_FILE);
      db.prepare(`
        INSERT INTO sessions(
          id, name, workspace_id, workspace_name, workspace_path, workspace_root,
          created_at, updated_at, status, thread_id, rollout_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        threadId,
        "imported-suite",
        "imported-suite",
        "imported-suite",
        importedWorkspacePath,
        WORKSPACE_ROOT,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
        "idle",
        threadId,
        rolloutPath
      );
      db.close();
    }

    await stopServer({ preserveRuntime: true });
    await startServer();

    response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: AUTH_TOKEN }),
    });
    assert.equal(response.status, 200);
    const resumedCookie = response.headers.get("set-cookie");

    response = await fetch(`${BASE_URL}/api/sessions/${threadId}/export`, {
      headers: { cookie: resumedCookie },
    });
    assert.equal(response.status, 200);
    let importedExport = await response.json();
    assert.equal(importedExport.session.messages.length, 2);
    assert.equal(importedExport.session.messages.at(-1).text, "réponse initiale");

    await fsp.writeFile(
      rolloutPath,
      [
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:00.000Z",
          payload: { type: "user_message", message: "question initiale" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:01.000Z",
          payload: { type: "agent_message", phase: "final_answer", message: "réponse initiale" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:02.000Z",
          payload: { type: "user_message", message: "question suivante" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-01-01T00:00:03.000Z",
          payload: { type: "agent_message", phase: "final_answer", message: "réponse rafraîchie" },
        }),
      ].join("\n"),
      "utf8"
    );

    response = await fetch(`${BASE_URL}/api/sessions/${threadId}/export`, {
      headers: { cookie: resumedCookie },
    });
    assert.equal(response.status, 200);
    importedExport = await response.json();
    assert.equal(importedExport.session.messages.length, 4);
    assert.equal(importedExport.session.messages.at(-1).text, "réponse rafraîchie");

    response = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: resumedCookie },
    });
    assert.equal(response.status, 200);

    response = await fetch(`${BASE_URL}/api/bootstrap`);
    assert.equal(response.status, 401);
  } finally {
    await stopServer();
  }
}, { timeout: 30000 });

test("runtime nettoie les process codex orphelins apres crash", async () => {
  const runtimeRoot = await fsp.mkdtemp(path.join(TMP_ROOT, "runtime-orphan-"));
  const dataDir = path.join(runtimeRoot, "data");
  const workspacePath = path.join(runtimeRoot, "workspace");
  const socketPath = path.join(dataDir, "runtime.sock");
  const stateFile = path.join(dataDir, "runtime-state.json");
  const pidFile = path.join(dataDir, "runtime.pid");
  const childPidFile = path.join(runtimeRoot, "codex-child.pid");
  const fakeBin = path.join(runtimeRoot, "bin");
  const fakeCodex = path.join(fakeBin, "codex");

  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(workspacePath, { recursive: true });
  await fsp.mkdir(fakeBin, { recursive: true });
  await fsp.writeFile(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s' \"$$\" > \"$CODEX_CHILD_PID_FILE\"",
      "trap 'exit 0' TERM INT",
      "while true; do sleep 1; done",
    ].join("\n"),
    { mode: 0o755 }
  );

  const runtimeEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
    CODEX_MOBILE_DATA_DIR: dataDir,
    CODEX_MOBILE_RUNTIME_SOCKET: socketPath,
    CODEX_MOBILE_RUNTIME_STATE_FILE: stateFile,
    CODEX_MOBILE_RUNTIME_PID_FILE: pidFile,
    CODEX_MOBILE_CONFIG_FILE: CONFIG_FILE,
    CODEX_HOME: TMP_ROOT,
    CODEX_CHILD_PID_FILE: childPidFile,
  };

  let runtimeA = null;
  let runtimeB = null;
  let childPid = 0;

  try {
    runtimeA = spawn(process.execPath, ["runtime.js"], {
      cwd: process.cwd(),
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForRuntimeSocket(socketPath);

    const started = await runtimeSocketRequest(socketPath, "POST", "/runs/start", {
      sessionId: "orphan-session",
      workspacePath,
      prompt: "tour qui bloque",
      attachments: [],
      threadId: null,
    });
    assert.equal(started.statusCode, 200);

    const childDeadline = Date.now() + 5000;
    while (Date.now() < childDeadline) {
      try {
        childPid = Number((await fsp.readFile(childPidFile, "utf8")).trim());
      } catch {}
      if (childPid > 0) {
        break;
      }
      await delay(100);
    }
    assert.equal(childPid > 0, true);
    assert.equal(isProcessAlive(childPid), true);

    runtimeA.kill("SIGKILL");
    await onceExit(runtimeA);
    runtimeA = null;

    assert.equal(isProcessAlive(childPid), true);

    runtimeB = spawn(process.execPath, ["runtime.js"], {
      cwd: process.cwd(),
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForRuntimeSocket(socketPath);

    const cleanupDeadline = Date.now() + 5000;
    let childCleaned = false;
    while (Date.now() < cleanupDeadline) {
      if (!isProcessAlive(childPid)) {
        childCleaned = true;
        break;
      }
      await delay(100);
    }
    assert.equal(childCleaned, true);

    const runs = await runtimeSocketRequest(socketPath, "GET", "/runs");
    assert.equal(runs.statusCode, 200);
    assert.equal(Array.isArray(runs.body?.runs), true);
    assert.equal(runs.body.runs[0]?.status, "running");
  } finally {
    if (runtimeA) {
      runtimeA.kill("SIGTERM");
      await onceExit(runtimeA).catch(() => {});
    }
    if (runtimeB) {
      runtimeB.kill("SIGTERM");
      await onceExit(runtimeB).catch(() => {});
    }
    if (childPid > 0 && isProcessAlive(childPid)) {
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
    }
  }
}, { timeout: 15000 });

async function startServer() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true });
  await fsp.writeFile(
    ENV_FILE,
    `CODEX_MOBILE_AUTH_TOKEN=${AUTH_TOKEN}\nGITHUB_TOKEN=${INITIAL_GITHUB_TOKEN}\nTELEGRAM_BOT_TOKEN=test-telegram-token\n`,
    "utf8"
  );
  await fsp.writeFile(
    SESSION_CONTEXT_FILE,
    [
      "SESSION_CONTEXT_MARKER",
      "Workspace: {{workspaceName}}",
      "Path: {{workspacePath}}",
      "Secrets: /etc/codex-mobile/.env",
      "Examples: GITHUB_TOKEN, HETZNER",
    ].join("\\n"),
    "utf8"
  );

  serverProcess = spawn("node", ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      CODEX_MOBILE_TEST_MODE: "1",
      CODEX_MOBILE_FORCE_AUTH: "1",
      CODEX_MOBILE_DATA_DIR: DATA_DIR,
      CODEX_MOBILE_DEFAULT_WORKSPACE_ROOT: WORKSPACE_ROOT,
      CODEX_MOBILE_CONFIG_FILE: CONFIG_FILE,
      CODEX_MOBILE_MODELS_CACHE_FILE: MODELS_CACHE_FILE,
      CODEX_MOBILE_ENV_FILE: ENV_FILE,
      CODEX_MOBILE_SESSION_CONTEXT_FILE: SESSION_CONTEXT_FILE,
      CODEX_MOBILE_RUNTIME_SOCKET: RUNTIME_SOCKET_FILE,
      CODEX_MOBILE_RUNTIME_STATE_FILE: RUNTIME_STATE_FILE,
      CODEX_MOBILE_RUNTIME_PID_FILE: RUNTIME_PID_FILE,
      CODEX_MOBILE_RUNTIME_RESTART_GRACE_MS: "400",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForServer();
}

async function stopServer({ preserveRuntime = false } = {}) {
  if (!serverProcess) {
    return;
  }

  const processRef = serverProcess;
  serverProcess = null;

  if (processRef.exitCode !== null) {
    return;
  }

  processRef.kill("SIGTERM");
  await new Promise((resolve) => processRef.once("exit", resolve));

  if (!preserveRuntime) {
    await stopRuntime();
  }
}

async function stopRuntime() {
  try {
    const pidText = await fsp.readFile(RUNTIME_PID_FILE, "utf8");
    const pid = Number(String(pidText).trim());
    if (pid > 0) {
      process.kill(pid, "SIGTERM");
      await delay(300);
    }
  } catch {}
  await fsp.rm(RUNTIME_PID_FILE, { force: true }).catch(() => {});
  await fsp.rm(RUNTIME_SOCKET_FILE, { force: true }).catch(() => {});
}

async function waitForServer() {
  const started = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes("Codex Mobile listening")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Server exited before start (${code})`));
    };
    const cleanup = () => {
      serverProcess.stdout.off("data", onData);
      serverProcess.stderr.off("data", onData);
      serverProcess.off("exit", onExit);
    };
    serverProcess.stdout.on("data", onData);
    serverProcess.stderr.on("data", onData);
    serverProcess.once("exit", onExit);
  });

  await Promise.race([
    started,
    (async () => {
      await delay(10000);
      throw new Error("Server start timeout");
    })(),
  ]);

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(100);
  }

  throw new Error("Server HTTP readiness timeout");
}

async function waitForRuntimeSocket(socketPath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await runtimeSocketRequest(socketPath, "GET", "/health");
      if (response.statusCode === 200) {
        return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error("Runtime socket readiness timeout");
}

async function runtimeSocketRequest(socketPath, method, requestPath, payload) {
  const body = payload == null ? null : Buffer.from(JSON.stringify(payload));
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function onceExit(child) {
  if (!child) {
    return Promise.resolve();
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", resolve));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
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
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function pdfDataUrl(text) {
  return `data:application/pdf;base64,${buildMinimalPdfBuffer(text).toString("base64")}`;
}

function zipDataUrl(entries) {
  const zip = new AdmZip();
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content || ""), "utf8");
    zip.addFile(entry.name, content);
  }
  return `data:application/zip;base64,${zip.toBuffer().toString("base64")}`;
}

function buildMinimalPdfBuffer(text) {
  const escapedText = String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  const stream = `BT\n/F1 18 Tf\n72 140 Td\n(${escapedText}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}
