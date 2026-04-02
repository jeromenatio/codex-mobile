import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);

test("scripts d'installation et wrapper detache", async (t) => {
  const cwd = process.cwd();

  await t.test("syntaxe shell valide", async () => {
    await execFileAsync("bash", ["-n", "install.sh"], { cwd });
    await execFileAsync("bash", ["-n", "install-detached.sh"], { cwd });
    await execFileAsync("bash", ["-n", "service.sh"], { cwd });
  });

  await t.test("install-detached transmet les variables au job systemd", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-mobile-install-"));
    const outputFile = path.join(tmpRoot, "result.txt");
    const scriptPath = path.join(tmpRoot, "fake-install.sh");
    const unitName = `codex-mobile-install-test-${process.pid}`;

    await fsp.writeFile(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `echo \"WORKSPACE=$CODEX_MOBILE_INSTALL_WORKSPACE_ROOT USER=$CODEX_MOBILE_INSTALL_USER SERVICE=$SERVICE_INSTALL MODE=$CODEX_MOBILE_INSTALL_LOGIN_MODE\" > ${JSON.stringify(outputFile)}`,
      ].join("\n"),
      "utf8"
    );
    await fsp.chmod(scriptPath, 0o755);

    const server = http.createServer((req, res) => {
      if (req.url === "/fake-install.sh") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(fs.readFileSync(scriptPath, "utf8"));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/fake-install.sh`;

    try {
      await execFileAsync(
        "bash",
        ["./install-detached.sh"],
        {
          cwd,
          env: {
            ...process.env,
            INSTALL_SCRIPT_URL: url,
            UNIT_NAME: unitName,
            WORKSPACE_ROOT: "/tmp/fake-root",
            SERVICE_INSTALL: "no",
          },
        }
      );

      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (fs.existsSync(outputFile)) {
          break;
        }
        await delay(200);
      }

      const output = await fsp.readFile(outputFile, "utf8");
      assert.match(output, /WORKSPACE=\/tmp\/fake-root/);
      assert.match(output, /SERVICE=no/);
      assert.match(output, /MODE=device/);

      await execFileAsync("systemctl", ["reset-failed", unitName]).catch(() => {});
    } finally {
      server.close();
      await fsp.rm(tmpRoot, { recursive: true, force: true });
      await execFileAsync("systemctl", ["stop", unitName]).catch(() => {});
      await execFileAsync("systemctl", ["reset-failed", unitName]).catch(() => {});
    }
  });
});
