import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "./store.mjs";
import { VERSION } from "./version.mjs";

const NAME = "overdrive";
const BIN = fileURLToPath(new URL("../bin/overdrive.mjs", import.meta.url));
const SKILL_DIR = fileURLToPath(new URL("../skills/overdrive", import.meta.url));
const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

let previewOnly = false;

function stableBin() {
  if (!/[\\/]_npx[\\/]/.test(PKG_ROOT)) return BIN;
  const dest = path.join(defaultDataDir(), "..", "app", VERSION);
  if (!previewOnly && !existsSync(path.join(dest, "bin", "overdrive.mjs"))) {
    for (const d of ["bin", "src", "ui", "skills", "package.json", "LICENSE"]) {
      if (existsSync(path.join(PKG_ROOT, d))) cpSync(path.join(PKG_ROOT, d), path.join(dest, d), { recursive: true });
    }
  }
  return path.join(dest, "bin", "overdrive.mjs");
}

export const SERVER = {
  command: process.execPath,
  get args() {
    return [stableBin(), "mcp"];
  },
};

const home = () => process.env.OVERDRIVE_INSTALL_HOME || os.homedir();
const appData = () =>
  process.env.OVERDRIVE_INSTALL_HOME
    ? path.join(home(), "AppData/Roaming")
    : process.env.APPDATA || path.join(home(), "Library/Application Support");

function cliEnv() {
  if (!process.env.OVERDRIVE_INSTALL_HOME) return {};
  return {
    HOME: home(),
    USERPROFILE: home(),
    CLAUDE_CONFIG_DIR: path.join(home(), ".claude"),
    CODEX_HOME: path.join(home(), ".codex"),
  };
}

function cmdOf(names) {
  const list = Array.isArray(names) ? names : [names];
  const locator = process.platform === "win32" ? "where.exe" : "which";
  for (const n of list) {
    const r = spawnSync(locator, [n], { shell: false, windowsHide: true, encoding: "utf8", timeout: 3000 });
    if (r.status === 0 && r.stdout) {
      const hit = r.stdout.split(/\r?\n/).find((l) => l.trim());
      if (hit) return { command: hit.trim(), prefix: [] };
    }
  }
  return null;
}

function runCli(cmd, args, { env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const useCmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
    const exe = useCmdShim ? "cmd.exe" : cmd;
    const argv = useCmdShim ? ["/d", "/s", "/c", cmd, ...args] : args;
    const child = spawn(exe, argv, {
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ code: -1, stdout, stderr: stderr + "\ntimed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function viaCli(names, addArgs, removeArgs, { dryRun, uninstall }) {
  const c = cmdOf(names);
  if (!c) return { ok: false, message: "not installed" };
  const args = uninstall ? removeArgs : addArgs;
  if (dryRun) return { ok: true, message: `would run: ${path.basename(c.command)} ${args.join(" ")}` };
  if (!uninstall) await runCli(c.command, [...c.prefix, ...removeArgs], { env: cliEnv() });
  const r = await runCli(c.command, [...c.prefix, ...args], { env: cliEnv() });
  const tail = (r.stdout + r.stderr).trim().split(/\r?\n/).pop();
  return r.code === 0 ? { ok: true, message: uninstall ? "removed" : "added (user scope)" } : { ok: false, message: tail || `exit ${r.code}` };
}

function editJson(file, set, { dryRun }) {
  let obj = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    try {
      obj = text.trim() ? JSON.parse(text) : {};
    } catch {
      return { ok: false, message: `${file} is not valid JSON.` };
    }
  }
  const before = JSON.stringify(obj);
  set(obj);
  if (JSON.stringify(obj) === before) return { ok: true, message: `no change needed (${file})` };
  if (dryRun) return { ok: true, message: `would update ${file}` };
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, file + ".bak");
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return { ok: true, message: `updated ${file}${existsSync(file + ".bak") ? " (backup: .bak)" : ""}` };
}

const mcpServersEntry = (uninstall) => (o) => {
  o.mcpServers ||= {};
  if (uninstall) delete o.mcpServers[NAME];
  else o.mcpServers[NAME] = { command: SERVER.command, args: SERVER.args };
};

export const HARNESSES = {
  antigravity: {
    name: "Antigravity (agy)",
    detect: () => Boolean(cmdOf(["agy", "antigravity"]) || existsSync(path.join(home(), ".gemini", "config"))),
    install: (o) => viaCli(["agy", "antigravity"], ["mcp", "add", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", NAME], o),
    skills: () => path.join(home(), ".gemini", "config", "skills"),
  },
  claude: {
    name: "Claude Code",
    detect: () => Boolean(cmdOf("claude")),
    install: (o) => viaCli("claude", ["mcp", "add", "-s", "user", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", "-s", "user", NAME], o),
    skills: () => path.join(process.env.OVERDRIVE_INSTALL_HOME ? path.join(home(), ".claude") : process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), "skills"),
  },
  codex: {
    name: "Codex",
    detect: () => Boolean(cmdOf("codex") || existsSync(path.join(home(), ".codex"))),
    install: (o) => viaCli("codex", ["mcp", "add", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", NAME], o),
    skills: () => path.join(home(), ".agents", "skills"),
  },
  devin: {
    name: "Devin CLI",
    detect: () => Boolean(cmdOf("devin")),
    install: (o) => viaCli("devin", ["mcp", "add", "-s", "user", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", "-s", "user", NAME], o),
    skills: () => path.join(home(), ".agents", "skills"),
  },
  grok: {
    name: "Grok CLI",
    detect: () => Boolean(cmdOf("grok")),
    install: (o) => viaCli("grok", ["mcp", "add", "-s", "user", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", "-s", "user", NAME], o),
  },
  muse: {
    name: "Muse Code",
    detect: () => Boolean(cmdOf("muse")),
    install: (o) => viaCli("muse", ["mcp", "add", NAME, "--user", "--", SERVER.command, ...SERVER.args], ["mcp", "remove", NAME, "--user"], o),
  },
  qwen: {
    name: "Qwen Code",
    detect: () => Boolean(cmdOf("qwen") || existsSync(path.join(home(), ".qwen"))),
    install: (o) => editJson(path.join(home(), ".qwen", "settings.json"), mcpServersEntry(o.uninstall), o),
  },
  hermes: {
    name: "Hermes Agent",
    detect: () => Boolean(cmdOf("hermes")),
    install: (o) => viaCli("hermes", ["mcp", "add", NAME, "--command", SERVER.command, "--args", ...SERVER.args], ["mcp", "remove", NAME], o),
  },
  cursor: {
    name: "Cursor",
    detect: () => Boolean(cmdOf("cursor") || existsSync(path.join(home(), ".cursor"))),
    install: (o) => editJson(path.join(home(), ".cursor", "mcp.json"), mcpServersEntry(o.uninstall), o),
  },
  opencode: {
    name: "OpenCode",
    detect: () => Boolean(cmdOf("opencode") || existsSync(path.join(home(), ".config", "opencode"))),
    install: (o) =>
      editJson(
        path.join(home(), ".config", "opencode", "opencode.json"),
        (c) => {
          c.mcp ||= {};
          if (o.uninstall) delete c.mcp[NAME];
          else c.mcp[NAME] = { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true };
        },
        o,
      ),
  },
  "claude-desktop": {
    name: "Claude Desktop",
    detect: () => existsSync(path.join(appData(), "Claude")),
    install: (o) => editJson(path.join(appData(), "Claude", "claude_desktop_config.json"), mcpServersEntry(o.uninstall), o),
  },
};

function installSkill(dir, { dryRun, uninstall }) {
  const dest = path.join(dir, NAME);
  if (dryRun) return `would ${uninstall ? "remove" : "copy"} skill ${dest}`;
  if (uninstall) {
    rmSync(dest, { recursive: true, force: true });
    return `removed skill ${dest}`;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(SKILL_DIR, dest, { recursive: true });
  return `skill -> ${dest}`;
}

export async function install({ harnesses = [], dryRun = false, uninstall = false } = {}) {
  previewOnly = dryRun;
  const ids = harnesses.length ? harnesses : Object.keys(HARNESSES).filter((h) => HARNESSES[h].detect());
  const out = [];
  const skillDirs = new Set();
  for (const id of ids) {
    const h = HARNESSES[id];
    if (!h) {
      out.push({ harness: id, ok: false, message: `unknown harness; known: ${Object.keys(HARNESSES).join(", ")}` });
      continue;
    }
    let r;
    try {
      r = await h.install({ dryRun, uninstall });
    } catch (e) {
      r = { ok: false, message: String(e?.message || e) };
    }
    if (r.ok && h.skills) skillDirs.add(h.skills());
    out.push({ harness: id, name: h.name, ...r });
  }
  for (const d of skillDirs) out.push({ harness: "skill", ok: true, message: installSkill(d, { dryRun, uninstall }) });
  return out;
}

export const manualConfig = () => ({ mcpServers: { [NAME]: { command: SERVER.command, args: SERVER.args } } });
