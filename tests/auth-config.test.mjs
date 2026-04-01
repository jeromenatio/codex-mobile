import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-mobile-auth-"));
const PORT = 4192;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(TMP_ROOT, "data");
const WORKSPACE_ROOT = path.join(TMP_ROOT, "workspaces");
const CONFIG_FILE = path.join(TMP_ROOT, "codex-config.toml");
const MODELS_CACHE_FILE = path.join(TMP_ROOT, "models-cache.json");
const ENV_FILE = path.join(TMP_ROOT, "codex-mobile.env");
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

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/retry`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const retried = await response.json();
    assert.equal(Array.isArray(retried.messages), true);
    assert.equal(retried.messages.length, 4);
    assert.equal(retried.messages[2].role, "user");
    assert.equal(retried.messages[2].text, "bonjour");
    assert.equal(retried.messages[3].role, "assistant");
    assert.equal(retried.messages[3].pending, true);

    response = await fetch(`${BASE_URL}/api/sessions/${created.session.id}/export`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const exported = await response.json();
    assert.equal(typeof exported.exportedAt, "string");
    assert.equal(exported.session.id, created.session.id);
    assert.equal(exported.session.workspaceName, "api-suite");
    assert.equal(Array.isArray(exported.session.messages), true);
    assert.equal(exported.session.messages.length, 4);
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

    response = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(response.status, 200);

    response = await fetch(`${BASE_URL}/api/bootstrap`);
    assert.equal(response.status, 401);
  } finally {
    await stopServer();
  }
}, { timeout: 30000 });

async function startServer() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true });
  await fsp.writeFile(
    ENV_FILE,
    `CODEX_MOBILE_AUTH_TOKEN=${AUTH_TOKEN}\nGITHUB_TOKEN=${INITIAL_GITHUB_TOKEN}\n`,
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
      CODEX_MOBILE_RUNTIME_SOCKET: RUNTIME_SOCKET_FILE,
      CODEX_MOBILE_RUNTIME_STATE_FILE: RUNTIME_STATE_FILE,
      CODEX_MOBILE_RUNTIME_PID_FILE: RUNTIME_PID_FILE,
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
}
