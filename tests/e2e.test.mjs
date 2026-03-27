import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-mobile-e2e-"));
const PORT = 4191;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(TMP_ROOT, "data");
const WORKSPACE_ROOT = path.join(TMP_ROOT, "workspaces-a");
const ALT_WORKSPACE_ROOT = path.join(TMP_ROOT, "workspaces-b");
const CONFIG_FILE = path.join(TMP_ROOT, "codex-config.toml");
const MODELS_CACHE_FILE = path.join(TMP_ROOT, "models-cache.json");

let serverProcess;
let browser;

test("suite e2e exhaustive hors voix", async (t) => {
  await startServer();
  browser = await chromium.launch({ headless: true });

  try {
    await t.test("etat vide et creation auto-selectionnee", async () => {
      const { page, context } = await newPage();

      await openSidebar(page);
      await expectText(page.locator("#sessionList"), "Aucune session.");
      await clickDom(page, "#openCreateModal");
      await page.fill("#workspaceInput", "alpha-suite");
      await page.fill("#promptInput", "");
      await clickDom(page, "#createSessionForm .primary-button");

      await expectText(page.locator("#activeSessionName"), "alpha-suite");
      await expectText(page.locator("#activeWorkspace"), "alpha-suite");
      await expectText(page.locator("#activeMessageCount"), "0 msg");

      await openSidebar(page);
      await expectText(page.locator("#sessionCount"), "1 session");
      await expectText(page.locator("#workspaceCount"), "1 workspace");

      await context.close();
    });

    await t.test("messagerie markdown copie et scroll", async () => {
      const { page, context } = await newPage();
    await activateSessionFromDrawer(page, "alpha-suite");

    await sendMessage(page, "__MARKDOWN__");
    await expectText(page.locator(".bubble.assistant").last(), "Réponse de test");
    assert.equal(await page.locator(".bubble.assistant h1").count(), 1);
    assert.equal(await page.locator(".bubble.assistant pre code").count(), 1);

    await grantClipboard(page);
    await clickDom(page.locator(".bubble.assistant .bubble-copy").last());
    await expectText(page.locator("#notifications"), "Message copié.");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /Réponse de test/);

    for (let index = 0; index < 6; index += 1) {
      await sendMessage(page, `__LONG__ bloc ${index}`);
      await expectText(page.locator(".bubble.assistant").last(), "Réponse longue");
    }

    await clickDom(page, "#scrollTopButton");
    await waitFor(async () => {
      const top = await page.locator("#messages").evaluate((node) => Math.round(node.scrollTop));
      assert.ok(top < 32, `scrollTop attendu proche de 0, reçu ${top}`);
    }, 3000);

    await clickDom(page, "#scrollBottomButton");
    await waitFor(async () => {
      const bottomGap = await page.locator("#messages").evaluate((node) =>
        Math.round(node.scrollHeight - (node.scrollTop + node.clientHeight))
      );
      assert.ok(bottomGap < 32, `scroll bas attendu proche de 0, reçu ${bottomGap}`);
    }, 3000);

    await context.close();
    });

    await t.test("interruption et reprise apres refresh", async () => {
      const { page, context } = await newPage();
    await activateSessionFromDrawer(page, "alpha-suite");

    await page.fill("#messageInput", "__SLOW__");
    await clickDom(page, "#sendButton");
    await expectAttr(page.locator("#sendButton"), "aria-label", "Interrompre");
    await expectText(page.locator(".bubble.assistant.pending").last(), "Codex réfléchit");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#messageInput").waitFor({ state: "visible" });
    await expectAttr(page.locator("#sendButton"), "aria-label", "Interrompre");
    await expectText(page.locator(".bubble.assistant.pending").last(), "Codex réfléchit");

    await clickDom(page, "#sendButton");
    await expectAttr(page.locator("#sendButton"), "aria-label", "Envoyer");
    await expectText(page.locator(".bubble.assistant").last(), "Réponse interrompue.");

    await context.close();
    });

    await t.test("gestion sessions recherche renommage suppression", async () => {
      const { page, context } = await newPage();

    await createSession(page, "beta-space");
    await createSession(page, "gamma-space");

    await openSidebar(page);
    await page.fill("#sessionSearchInput", "gamma");
    await expectText(page.locator("#sessionList"), "gamma-space");
    assert.equal(await page.locator(".session-item").count(), 1);

    await page.fill("#sessionSearchInput", "");
    const betaItem = page.locator(".session-item").filter({ hasText: "beta-space" });
    await clickDom(betaItem.locator("[data-action='rename']"));
    await page.fill("#renameSessionInput", "beta-renamed");
    await clickDom(page, "#renameSessionForm .primary-button");
    await openSidebar(page);
    await expectText(page.locator("#sessionList"), "beta-renamed");

    const gammaItem = page.locator(".session-item").filter({ hasText: "gamma-space" });
    await clickDom(gammaItem.locator("[data-action='delete']"));
    await expectText(page.locator("#deleteModalText"), "gamma-space");
    await clickDom(page, "#confirmDeleteButton");
    await openSidebar(page);
    await waitFor(async () => {
      assert.equal((await page.locator("#sessionList").innerText()).includes("gamma-space"), false);
    });

    await context.close();
    });

    await t.test("configuration app codex et changement de modele", async () => {
      const { page, context } = await newPage();
    await activateSessionFromDrawer(page, "alpha-suite");

    await clickDom(page, "#openConfigModal");
    await page.fill("#notificationDurationInput", "9");
    await page.fill("#workspaceRootInput", ALT_WORKSPACE_ROOT);
    await page.fill("#githubTokenInput", "ghp_ui_token");
    await setCheckbox(page, "#sandboxDangerInput", true);
    await setCheckbox(page, "#approvalNeverInput", true);
    await setCheckbox(page, "#hideFullAccessWarningInput", true);
    await setCheckbox(page, "#searchInput", true);
    await page.selectOption("#themeSelect", "arctic-glass");
    await clickDom(page, "#saveConfigButton");

    await expectText(page.locator("#notifications"), "Configuration enregistree");
    const currentTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(currentTheme, "arctic-glass");
    assert.equal(fs.existsSync(ALT_WORKSPACE_ROOT), true);

    await openSidebar(page);
    await expectText(page.locator("#sessionList"), "Aucune session.");

    await clickDom(page, "#openConfigModal");
    await expectValue(page.locator("#githubTokenInput"), "ghp_ui_token");
    await page.fill("#workspaceRootInput", WORKSPACE_ROOT);
    await clickDom(page, "#saveConfigButton");
    await openSidebar(page);
    await expectText(page.locator("#sessionList"), "alpha-suite");

    await clickDom(page, "#openModelModal");
    await waitFor(async () => {
      assert.equal(await page.locator(".model-option").count(), 4);
    });
    await clickDom(page.locator(".model-option").filter({ hasText: "GPT-5.4-Mini" }));
    await expectText(page.locator("#confirmModelText"), "gpt-5.4-mini");
    await clickDom(page, "#confirmModelChangeButton");
    await expectText(page.locator("#activeModelLabel"), "gpt-5.4-mini");

    const codexConfig = await (await fetch(`${BASE_URL}/api/config/codex`)).json();
    assert.equal(codexConfig.model, "gpt-5.4-mini");
    assert.equal(codexConfig.sandboxDangerFullAccess, true);
    assert.equal(codexConfig.approvalNever, true);
    assert.equal(codexConfig.hideFullAccessWarning, true);
    assert.equal(codexConfig.search, true);

    await context.close();
    });

    await t.test("gestionnaire d images et envoi avec pieces jointes", async () => {
      const { page, context } = await newPage();
    await activateSessionFromDrawer(page, "alpha-suite");

    await page.setInputFiles("#imageInput", [
      pngPayload("one.png"),
      pngPayload("two.png"),
    ]);
    await clickDom(page, "#pickImagesButton");
    assert.equal(await page.locator(".image-card").count(), 2);
    await clickDom(page.locator("[data-remove-image]").first());
    assert.equal(await page.locator(".image-card").count(), 1);
    await clickDom(page, "#doneImageModalButton");
    await page.fill("#messageInput", "avec image");
    await clickDom(page, "#sendButton");
    await expectText(page.locator(".bubble.assistant").last(), "Images reçues: 1");

    await page.setInputFiles("#imageInput", [pngPayload("clear.png")]);
    await clickDom(page, "#clearComposerButton");
    await clickDom(page, "#pickImagesButton");
    await expectText(page.locator("#imageManagerList"), "Aucune image attachée.");
    await clickDom(page, "#doneImageModalButton");

    await context.close();
    });

    await t.test("prompts rapides CRUD et insertion", async () => {
      const { page, context } = await newPage();
    await activateSessionFromDrawer(page, "alpha-suite");

    await clickDom(page, "#openPromptModal");
    const defaultPrompt = page.locator(".prompt-item").filter({ hasText: "Commit & push" });
    await expectAttr(defaultPrompt.locator("[data-prompt-action='edit']"), "disabled", "");
    await expectAttr(defaultPrompt.locator("[data-prompt-action='delete']"), "disabled", "");
    await clickDom(page, "#openPromptEditorButton");
    await page.fill("#promptNameInput", "Résumé");
    await page.fill("#promptTextInput", "Fais un résumé concis.");
    await clickDom(page, "#savePromptButton");
    await expectText(page.locator("#promptList"), "Résumé");

    const promptItem = page.locator(".prompt-item").filter({ hasText: "Résumé" });
    await clickDom(promptItem.locator("[data-prompt-action='edit']"));
    await page.fill("#promptTextInput", "Fais un résumé très concis.");
    await clickDom(page, "#savePromptButton");
    await expectText(page.locator("#promptList"), "très concis");

    await clickDom(promptItem.locator("[data-prompt-action='use']"));
    await expectValue(page.locator("#messageInput"), "Fais un résumé très concis.");

    await clickDom(page, "#openPromptModal");
    await clickDom(page.locator(".prompt-item").filter({ hasText: "Résumé" }).locator("[data-prompt-action='delete']"));
    await expectText(page.locator("#promptList"), "Commit & push");

    await context.close();
    });
  } finally {
    if (browser) {
      await browser.close();
    }
    await stopServer();
  }
}, { timeout: 120000 });

async function startServer() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true });
  await fsp.mkdir(ALT_WORKSPACE_ROOT, { recursive: true });

  serverProcess = spawn("node", ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      CODEX_MOBILE_TEST_MODE: "1",
      CODEX_MOBILE_DATA_DIR: DATA_DIR,
      CODEX_MOBILE_DEFAULT_WORKSPACE_ROOT: WORKSPACE_ROOT,
      CODEX_MOBILE_CONFIG_FILE: CONFIG_FILE,
      CODEX_MOBILE_MODELS_CACHE_FILE: MODELS_CACHE_FILE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/bootstrap`);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(200);
  }

  throw new Error(`Serveur de test indisponible.\n${stderr}`);
}

async function stopServer() {
  if (!serverProcess) {
    return;
  }
  serverProcess.kill("SIGTERM");
  await delay(500);
  if (!serverProcess.killed) {
    serverProcess.kill("SIGKILL");
  }
}

async function newPage() {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const nativeScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function scrollToPatched(...args) {
      const [firstArg] = args;
      if (firstArg && typeof firstArg === "object" && "top" in firstArg) {
        this.scrollTop = Number(firstArg.top) || 0;
        if ("left" in firstArg) {
          this.scrollLeft = Number(firstArg.left) || 0;
        }
        return;
      }
      return nativeScrollTo.apply(this, args);
    };
  });
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#messageInput").waitFor({ state: "visible" });
  return { context, page };
}

async function openSidebar(page) {
  const searchInput = page.locator("#sessionSearchInput");
  if (await searchInput.isVisible()) {
    return;
  }
  await page.locator("#toggleSidebar").click({ force: true });
  await searchInput.waitFor({ state: "visible" });
}

async function activateSessionFromDrawer(page, name) {
  await openSidebar(page);
  await clickDom(page.locator(".session-item").filter({ hasText: name }).locator("[data-action='open']"));
  await expectText(page.locator("#activeSessionName"), name);
}

async function createSession(page, workspace) {
  await clickDom(page, "#openCreateModal");
  await page.fill("#workspaceInput", workspace);
  await page.fill("#promptInput", "");
  await clickDom(page, "#createSessionForm .primary-button");
  await expectText(page.locator("#activeSessionName"), workspace);
}

async function sendMessage(page, text) {
  await page.fill("#messageInput", text);
  await clickDom(page, "#sendButton");
}

async function clickDom(target, selector) {
  if (selector) {
    await target.locator(selector).evaluate((element) => element.click());
    return;
  }
  await target.evaluate((element) => element.click());
}

async function setCheckbox(page, selector, checked) {
  await page.locator(selector).evaluate((element, nextChecked) => {
    element.checked = Boolean(nextChecked);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, checked);
}

async function expectText(locator, text) {
  await locator.waitFor({ state: "visible" });
  await waitFor(async () => {
    const value = await locator.innerText();
    assert.match(value, new RegExp(escapeRegExp(text), "i"));
  });
}

async function expectValue(locator, text) {
  await waitFor(async () => {
    assert.equal(await locator.inputValue(), text);
  });
}

async function expectAttr(locator, name, value) {
  await waitFor(async () => {
    assert.equal(await locator.getAttribute(name), value);
  });
}

async function waitFor(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

async function grantClipboard(page) {
  await page.evaluate(() => navigator.clipboard.writeText(""));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pngPayload(name) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnHCq4AAAAASUVORK5CYII=",
      "base64"
    ),
  };
}
