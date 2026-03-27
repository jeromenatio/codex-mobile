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
    assert.equal(initialConfig.githubToken, INITIAL_GITHUB_TOKEN);

    const nextRoot = path.join(TMP_ROOT, "workspaces-alt");
    const nextGithubToken = "ghp_updated_test_token";
    response = await fetch(`${BASE_URL}/api/config/app`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        cookie,
      },
      body: JSON.stringify({ workspaceRoot: nextRoot, githubToken: nextGithubToken }),
    });
    assert.equal(response.status, 200);
    const updatedConfig = await response.json();
    assert.equal(updatedConfig.workspaceRoot, nextRoot);
    assert.equal(updatedConfig.githubToken, nextGithubToken);
    assert.equal(fs.existsSync(nextRoot), true);

    const envText = await fsp.readFile(ENV_FILE, "utf8");
    assert.match(envText, /^GITHUB_TOKEN=ghp_updated_test_token$/m);
    assert.match(envText, /^CODEX_MOBILE_AUTH_TOKEN=test-auth-token$/m);

    response = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(response.status, 200);

    response = await fetch(`${BASE_URL}/api/bootstrap`, {
      headers: { cookie },
    });
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForServer();
}

async function stopServer() {
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
