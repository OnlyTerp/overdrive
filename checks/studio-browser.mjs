import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { startStudioServer } from "../src/server.mjs";
import { OverdriveStore } from "../src/store.mjs";
import { defaultScratchBase } from "../src/paths.mjs";

const SCRATCH_BASE = defaultScratchBase();

function findBrowserBinary() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function rmDirSafe(dir) {
  if (!dir || !existsSync(dir)) return;
  for (let i = 0; i < 12; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
  }
}

function killBrowserTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true });
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

async function launchHeadlessCdp(browserBin, userDataDir) {
  const child = spawn(
    browserBin,
    [
      "--headless=new",
      "--disable-gpu",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let stderrBuf = "";
    const activePortPath = path.join(userDataDir, "DevToolsActivePort");
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for headless CDP endpoint. stderr: ${stderrBuf.slice(-500)}`));
    }, 15_000);

    const checkFile = () => {
      if (!existsSync(activePortPath)) return null;
      const lines = readFileSync(activePortPath, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2) return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
      return null;
    };

    const poll = setInterval(() => {
      const fromFile = checkFile();
      if (fromFile) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(fromFile);
      }
    }, 100);

    child.stderr.on("data", (chunk) => {
      stderrBuf += String(chunk);
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(m[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`Browser exited prematurely (${code}): ${stderrBuf.slice(-500)}`));
    });
  });

  const u = new URL(wsUrl);
  const listRes = await fetch(`http://127.0.0.1:${u.port}/json/list`);
  const targets = await listRes.json();
  const pageTarget = targets.find((t) => t.type === "page") || targets[0];
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error(`No CDP page target found: ${JSON.stringify(targets)}`);
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", (ev) => reject(new Error(`CDP WebSocket error: ${ev.message || "unknown"}`)), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) fn(msg.params);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const on = (method, fn) => {
    const arr = listeners.get(method) || [];
    arr.push(fn);
    listeners.set(method, arr);
  };

  const evalJs = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Page eval exception: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  };

  const waitFor = async (expression, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const val = await evalJs(expression);
      if (val) return val;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for condition: ${expression}`);
  };

  return { child, ws, send, on, evalJs, waitFor };
}

function relativeLuminance(rgbStr) {
  const m = String(rgbStr || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const chans = [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2];
}

function contrastRatio(bgRgb, fgRgb) {
  const l1 = relativeLuminance(bgRgb);
  const l2 = relativeLuminance(fgRgb);
  if (l1 === null || l2 === null) return 0;
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

describe("Overdrive Studio v0.2.0 headless browser E2E", () => {
  it("drives showcase seed, DAG, inspector, keyboard nav, themes, and responsive layout with zero errors", async () => {
    const browserBin = findBrowserBinary();
    assert.ok(browserBin, "Edge or Chrome binary must exist for headless CDP check");

    mkdirSync(SCRATCH_BASE, { recursive: true });
    const userDataDir = mkdtempSync(path.join(SCRATCH_BASE, "cdp-profile-"));
    const dataDir = mkdtempSync(path.join(SCRATCH_BASE, "cdp-db-"));

    const store = new OverdriveStore(dataDir);
    const srv = await startStudioServer(store, { port: 0, fixedPort: false });
    let cdp = null;

    try {
      cdp = await launchHeadlessCdp(browserBin, userDataDir);
      const hasRsiApi = await fetch(`${srv.origin}/api/rsi/overview`, {
        headers: { "X-Overdrive-Token": srv.token },
      })
        .then((r) => r.status !== 404)
        .catch(() => false);
      const consoleErrors = [];
      const pageErrors = [];
      const badResponses = [];
      const failedRequests = [];

      cdp.on("Runtime.consoleAPICalled", (p) => {
        if (p.type === "error" || p.type === "assert") {
          consoleErrors.push(p.args?.map((a) => a.value ?? a.description).join(" ") || "console.error");
        }
      });
      cdp.on("Runtime.exceptionThrown", (p) => {
        pageErrors.push(p.exceptionDetails?.text || JSON.stringify(p.exceptionDetails));
      });
      cdp.on("Network.responseReceived", (p) => {
        if (p.response?.status >= 400) {
          if (!hasRsiApi && p.response.status === 404 && String(p.response.url || "").endsWith("/api/rsi/overview")) {
            return;
          }
          badResponses.push(`${p.response.status} ${p.response.url}`);
        }
      });
      cdp.on("Network.loadingFailed", (p) => {
        if (!p.canceled) {
          failedRequests.push(`${p.errorText} (${p.type})`);
        }
      });

      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Network.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });

      await cdp.send("Page.navigate", { url: srv.launchUrl });
      await cdp.waitFor('Boolean(document.getElementById("od-shell")?.dataset?.ready === "true" && document.getElementById("dag-root"))');
      await cdp.waitFor('Boolean(document.getElementById("btn-showcase-cta") || document.getElementById("btn-showcase"))');

      // 1. Trigger Showcase Seed via UI CTA
      await cdp.evalJs('(document.getElementById("btn-showcase-cta") || document.getElementById("btn-showcase")).click()');
      await cdp.waitFor('document.querySelectorAll("[data-lane-id]").length > 0');

      const laneCount = await cdp.evalJs('document.querySelectorAll("[data-lane-id]").length');
      assert.ok(laneCount >= 2, `Expected >=2 showcase lane nodes, got ${laneCount}`);

      // 2. Click a lane node -> verify Inspector updates and real diff lines load
      const clickedLane = await cdp.evalJs(`(() => {
        const nodes = [...document.querySelectorAll("[data-lane-id]")];
        const target = nodes[1] || nodes[0];
        target.click();
        return target.dataset.laneId;
      })()`);
      await cdp.waitFor(`document.getElementById("inspector-header-title").textContent.includes(${JSON.stringify(clickedLane)})`);
      await cdp.waitFor('document.querySelectorAll(".od-diff-line").length > 0');

      // 3. Keyboard shortcuts: t (timeline toggle), g (graph + arm + Esc), d (diff), ? (shortcuts), Ctrl+K (palette)
      const tlInitiallyOpen = await cdp.evalJs('!document.getElementById("timeline-dock").hidden');
      assert.equal(tlInitiallyOpen, true);

      const dispatchChar = async (key, code, modifiers = 0, keyCode = 0) => {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code,
          modifiers,
          windowsVirtualKeyCode: keyCode || key.toUpperCase().charCodeAt(0),
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          modifiers,
          windowsVirtualKeyCode: keyCode || key.toUpperCase().charCodeAt(0),
        });
      };

      await dispatchChar("t", "KeyT");
      await cdp.waitFor('document.getElementById("timeline-dock").hidden === true');
      await dispatchChar("t", "KeyT");
      await cdp.waitFor('document.getElementById("timeline-dock").hidden === false');

      await dispatchChar("d", "KeyD");
      await cdp.waitFor('!document.getElementById("inspector-drawer").hidden');

      await dispatchChar("g", "KeyG");
      await dispatchChar("Escape", "Escape", 0, 27);
      await cdp.waitFor('document.getElementById("armed-banner").hidden === true');

      await dispatchChar("?", "Slash", 8, 191);
      await cdp.waitFor('!document.getElementById("shortcuts-root").hidden');
      await dispatchChar("Escape", "Escape", 0, 27);
      await cdp.waitFor('document.getElementById("shortcuts-root").hidden === true');

      // Ctrl+K -> Command Palette
      await dispatchChar("k", "KeyK", 2, 75);
      await cdp.waitFor('!document.getElementById("palette-root").hidden');
      await dispatchChar("Escape", "Escape", 0, 27);
      await cdp.waitFor('document.getElementById("palette-root").hidden === true');

      // 4. Layout overflow + computed style & contrast in Dark and Light themes
      const checkViewport = async (width, height) => {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await cdp.evalJs("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        const metrics = await cdp.evalJs(`(() => {
          const de = document.documentElement;
          const bodyCs = getComputedStyle(document.body);
          const numEl = document.querySelector(".od-num");
          const numCs = numEl ? getComputedStyle(numEl) : null;
          return {
            scrollWidth: de.scrollWidth,
            clientWidth: de.clientWidth,
            theme: de.dataset.theme || "dark",
            bg: bodyCs.backgroundColor,
            fg: bodyCs.color,
            tabular: numCs ? numCs.fontVariantNumeric : "",
          };
        })()`);
        assert.ok(
          metrics.scrollWidth <= metrics.clientWidth,
          `Horizontal overflow at ${width}x${height}: scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`,
        );
        assert.match(metrics.tabular, /tabular-nums/);
        const ratio = contrastRatio(metrics.bg, metrics.fg);
        assert.ok(ratio >= 4.5, `Low text contrast (${ratio.toFixed(2)}) in theme ${metrics.theme}: bg=${metrics.bg}, fg=${metrics.fg}`);
      };

      await checkViewport(1440, 900);
      await checkViewport(1024, 768);

      // Toggle to light theme and re-verify contrast + overflow
      await cdp.evalJs('document.getElementById("btn-theme").click()');
      await cdp.waitFor('document.documentElement.dataset.theme === "light"');
      await checkViewport(1440, 900);
      await checkViewport(1024, 768);

      // 5. Switch to Evolution (RSI) tab via shortcut "5", verify render & zero overflow in light + dark themes
      await dispatchChar("5", "Digit5", 0, 53);
      await cdp.waitFor('!document.getElementById("panel-rsi").hidden && Boolean(document.querySelector(".od-rsi"))');
      const rsiText = await cdp.evalJs('document.getElementById("panel-rsi").textContent');
      assert.match(rsiText, /System evolution & daily self-tuning/);
      assert.match(rsiText, /Strict local · private/);
      assert.match(rsiText, /Questions on paused projects/);
      await checkViewport(1440, 900);
      await checkViewport(1024, 768);

      await cdp.evalJs('document.getElementById("btn-theme").click()');
      await cdp.waitFor('document.documentElement.dataset.theme === "dark"');
      await checkViewport(1440, 900);

      // Return to Overview tab via "1"
      await dispatchChar("1", "Digit1", 0, 49);
      await cdp.waitFor('!document.getElementById("panel-map").hidden && document.getElementById("panel-rsi").hidden');

      assert.deepEqual(consoleErrors, [], `Console errors observed: ${consoleErrors.join("; ")}`);
      assert.deepEqual(pageErrors, [], `Uncaught page errors observed: ${pageErrors.join("; ")}`);
      assert.deepEqual(badResponses, [], `HTTP >=400 responses observed: ${badResponses.join("; ")}`);
      assert.deepEqual(failedRequests, [], `Failed network requests observed: ${failedRequests.join("; ")}`);
    } finally {
      try {
        cdp?.ws?.close?.();
      } catch {}
      killBrowserTree(cdp?.child);
      await srv.close();
      store.close();
      rmDirSafe(userDataDir);
      rmDirSafe(dataDir);
    }
  });
});
