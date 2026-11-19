import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const DEFAULT_SLOT_LIMITS = Object.freeze({
  "local-heavy": 1,
  aipc: 2,
  "aipc-gpu": 1,
  "devin-vm": 4,
});

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import {
  defaultAipcScript,
  defaultDevinVmBridge,
  defaultLockDir as resolveDefaultLockDir,
} from "./paths.mjs";

export function defaultLockDir() {
  return resolveDefaultLockDir();
}

function safeKeyName(resourceKey) {
  return String(resourceKey || "default").replace(/[^A-Za-z0-9_.-]/g, "_") || "default";
}

/** Check whether an OS PID is alive using process.kill(pid, 0) (EPERM = alive, ESRCH = dead). */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readLockInfo(lockPath) {
  try {
    const st = statSync(lockPath);
    const raw = readFileSync(lockPath, "utf8");
    if (!raw.trim()) {
      return { empty: true, mtimeMs: st.mtimeMs, data: null };
    }
    const data = JSON.parse(raw);
    return { empty: false, mtimeMs: st.mtimeMs, data };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    return { corrupt: true, mtimeMs: 0, data: null };
  }
}

function isLockStale(info, staleMs) {
  if (!info) return false;
  if (info.corrupt) return true;
  if (info.empty) {
    return Date.now() - info.mtimeMs > 5000;
  }
  const d = info.data;
  if (!d || typeof d !== "object") return true;
  if (Number.isInteger(d.pid) && d.pid > 0) {
    // Live owner PID must never be reaped solely due to long-running job elapsed time.
    return !isPidAlive(d.pid);
  }
  const acquiredAt = Number(d.acquiredAt ?? info.mtimeMs);
  if (Number.isFinite(acquiredAt) && Date.now() - acquiredAt > staleMs) {
    return true;
  }
  return false;
}

function isSlotStillHeldByPid(lockDir, resourceKey, limit, pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) return false;
  const safeKey = safeKeyName(resourceKey);
  const effectiveLimit =
    Number.isInteger(limit) && limit >= 1 ? limit : (DEFAULT_SLOT_LIMITS[resourceKey] ?? 1);
  for (let idx = 0; idx < effectiveLimit; idx++) {
    const lp = path.join(lockDir, `${safeKey}.slot-${idx}.lock`);
    const info = readLockInfo(lp);
    if (info && !info.corrupt && !info.empty && info.data?.pid === pid) {
      return true;
    }
  }
  return false;
}

function tryReapStaleLock(lockPath, staleMs) {
  const pre = readLockInfo(lockPath);
  if (!pre || !isLockStale(pre, staleMs)) return false;

  const reapPath = `${lockPath}.reap`;
  let reapFd = null;
  try {
    reapFd = openSync(reapPath, "wx");
    writeFileSync(reapFd, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
  } catch (err) {
    if (err?.code === "EEXIST") {
      try {
        const st = statSync(reapPath);
        if (Date.now() - st.mtimeMs > 5000) unlinkSync(reapPath);
      } catch {}
    }
    return false;
  } finally {
    if (reapFd !== null) {
      try {
        closeSync(reapFd);
      } catch {}
    }
  }

  try {
    const cur = readLockInfo(lockPath);
    if (cur && isLockStale(cur, staleMs)) {
      try {
        unlinkSync(lockPath);
        return true;
      } catch (err) {
        return err?.code === "ENOENT";
      }
    }
    return false;
  } finally {
    try {
      unlinkSync(reapPath);
    } catch {}
  }
}

function tryClaimAnySlot(resourceKey, effectiveLimit, rootDir, pid, staleMs) {
  const safeKey = safeKeyName(resourceKey);
  let heldBySamePid = false;

  for (let idx = 0; idx < effectiveLimit; idx++) {
    const lockPath = path.join(rootDir, `${safeKey}.slot-${idx}.lock`);
    const nonce = randomUUID();
    const acquiredAt = Date.now();
    let fd = null;
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(
        fd,
        JSON.stringify({ pid, resourceKey, slot: idx, acquiredAt, nonce }),
        "utf8",
      );
      closeSync(fd);
      fd = null;
      let released = false;
      return {
        slot: {
          resourceKey,
          slot: idx,
          limit: effectiveLimit,
          pid,
          acquiredAt,
          nonce,
          lockPath: lockPath.replaceAll("\\", "/"),
          release() {
            if (released) return;
            released = true;
            try {
              const info = readLockInfo(lockPath);
              if (info?.data?.nonce === nonce) {
                unlinkSync(lockPath);
              }
            } catch {}
          },
        },
        heldBySamePid: false,
      };
    } catch (err) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
      if (err?.code !== "EEXIST") throw err;

      if (tryReapStaleLock(lockPath, staleMs)) {
        idx--;
        continue;
      }
      const existing = readLockInfo(lockPath);
      if (existing?.data?.pid === process.pid) {
        heldBySamePid = true;
      }
    }
  }

  return { slot: null, heldBySamePid };
}

/**
 * Acquire a cross-process lockfile semaphore slot under OVERDRIVE_LOCK_DIR.
 * Automatically reaps stale/dead-PID locks via process.kill(pid, 0) ESRCH vs EPERM check.
 */
export function acquireSlot(
  resourceKey,
  { limit = undefined, lockDir = undefined, pid = process.pid, staleMs = 600_000, waitMs = 3000 } = {},
) {
  const effectiveLimit =
    Number.isInteger(limit) && limit >= 1 ? limit : (DEFAULT_SLOT_LIMITS[resourceKey] ?? 1);
  const rootDir = path.resolve(lockDir || defaultLockDir());
  mkdirSync(rootDir, { recursive: true });

  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  while (true) {
    const attempt = tryClaimAnySlot(resourceKey, effectiveLimit, rootDir, pid, staleMs);
    if (attempt.slot) return attempt.slot;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const err = new Error(
        `SLOT_BUSY: unable to acquire slot for "${resourceKey}" (limit=${effectiveLimit}) within ${waitMs}ms`,
      );
      err.code = "SLOT_BUSY";
      throw err;
    }
    sleepSync(Math.min(25, remaining));
  }
}

async function acquireSlotAsync(
  resourceKey,
  { limit = undefined, lockDir = undefined, pid = process.pid, staleMs = 600_000, waitMs = 3000 } = {},
) {
  const effectiveLimit =
    Number.isInteger(limit) && limit >= 1 ? limit : (DEFAULT_SLOT_LIMITS[resourceKey] ?? 1);
  const rootDir = path.resolve(lockDir || defaultLockDir());
  mkdirSync(rootDir, { recursive: true });

  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  while (true) {
    const attempt = tryClaimAnySlot(resourceKey, effectiveLimit, rootDir, pid, staleMs);
    if (attempt.slot) return attempt.slot;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const err = new Error(
        `SLOT_BUSY: unable to acquire slot for "${resourceKey}" (limit=${effectiveLimit}) within ${waitMs}ms`,
      );
      err.code = "SLOT_BUSY";
      throw err;
    }
    await sleepAsync(Math.min(25, remaining));
  }
}

/**
 * Execute fn(slot) holding a semaphore slot with guaranteed try/finally release.
 * Supports both synchronous callbacks and async/Promise-returning callbacks.
 */
export function withSlot(resourceKey, optsOrFn, maybeFn) {
  const opts = typeof optsOrFn === "function" ? {} : (optsOrFn || {});
  const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
  if (typeof fn !== "function") {
    throw new Error("withSlot requires a callback function.");
  }

  const effectiveLimit =
    Number.isInteger(opts.limit) && opts.limit >= 1
      ? opts.limit
      : (DEFAULT_SLOT_LIMITS[resourceKey] ?? 1);
  const rootDir = path.resolve(opts.lockDir || defaultLockDir());
  mkdirSync(rootDir, { recursive: true });

  const initial = tryClaimAnySlot(
    resourceKey,
    effectiveLimit,
    rootDir,
    opts.pid ?? process.pid,
    opts.staleMs ?? 600_000,
  );

  if (initial.slot) {
    const slot = initial.slot;
    try {
      const res = fn(slot);
      if (res && typeof res.then === "function") {
        return res.then(
          (val) => {
            slot.release();
            return val;
          },
          (err) => {
            slot.release();
            throw err;
          },
        );
      }
      slot.release();
      return res;
    } catch (err) {
      slot.release();
      throw err;
    }
  }

  // If held by the current Node process and caller isn't forcing sync wait, yield to event loop so async holders finish.
  if (initial.heldBySamePid && !opts.sync) {
    return acquireSlotAsync(resourceKey, opts).then(async (slot) => {
      try {
        return await fn(slot);
      } finally {
        slot.release();
      }
    });
  }

  const slot = acquireSlot(resourceKey, opts);
  try {
    const res = fn(slot);
    if (res && typeof res.then === "function") {
      return res.then(
        (val) => {
          slot.release();
          return val;
        },
        (err) => {
          slot.release();
          throw err;
        },
      );
    }
    slot.release();
    return res;
  } catch (err) {
    slot.release();
    throw err;
  }
}

function runLocalShell(cmd, { cwd, timeoutMs, env }) {
  const isWin = process.platform === "win32";
  const exe = isWin ? "powershell.exe" : "sh";
  const argv = isWin ? ["-NoProfile", "-Command", cmd] : ["-lc", cmd];
  const r = spawnSync(exe, argv, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    exitCode: r.status ?? -1,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || "") + (r.error ? `\n${r.error.message}` : ""),
    machine: "local",
  };
}

function callDevinBridgeSync(devinBridge, toolName, payload, { timeoutMs, env }) {
  const r = spawnSync(process.execPath, [devinBridge, "call", toolName, "--json", JSON.stringify(payload)], {
    env,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (r.status !== 0) {
    throw new Error(
      `Devin VM bridge ${toolName} failed (${r.status ?? -1}): ${(r.stderr || r.stdout || r.error?.message || "").trim()}`,
    );
  }
  const text = String(r.stdout || "").trim();
  return text ? JSON.parse(text) : {};
}

function runDevinVmWithRunnerOrBridge(cmd, opts) {
  const { cwd, timeoutMs, env, devinBridge, runner } = opts;

  if (runner && typeof runner === "object" && typeof runner.spawn === "function" && typeof runner.exec === "function") {
    let vm = null;
    let vmSessionId = null;
    const runResult = (() => {
      try {
        const spawned = runner.spawn({ cmd, cwd, timeoutMs, env, devinBridge });
        if (spawned && typeof spawned.then === "function") {
          return spawned.then(async (s) => {
            vm = s;
            vmSessionId = s?.session_id || s?.sessionId || s?.id || null;
            try {
              const ex = await runner.exec({ sessionId: vmSessionId, vm: s, cmd, cwd, timeoutMs, env });
              return {
                exitCode: ex?.exitCode ?? ex?.exit_code ?? -1,
                stdout: String(ex?.stdout || ""),
                stderr: String(ex?.stderr || ""),
                machine: ex?.machine || "devin-vm",
                vmSessionId,
              };
            } finally {
              if (vm && typeof runner.archive === "function") {
                await runner.archive(vmSessionId, vm);
              }
            }
          });
        }
        vm = spawned;
        vmSessionId = spawned?.session_id || spawned?.sessionId || spawned?.id || null;
        const ex = runner.exec({ sessionId: vmSessionId, vm, cmd, cwd, timeoutMs, env });
        if (ex && typeof ex.then === "function") {
          return ex.then(
            (resolved) => ({
              exitCode: resolved?.exitCode ?? resolved?.exit_code ?? -1,
              stdout: String(resolved?.stdout || ""),
              stderr: String(resolved?.stderr || ""),
              machine: resolved?.machine || "devin-vm",
              vmSessionId,
            }),
          ).finally(async () => {
            if (vm && typeof runner.archive === "function") {
              await runner.archive(vmSessionId, vm);
            }
          });
        }
        try {
          return {
            exitCode: ex?.exitCode ?? ex?.exit_code ?? -1,
            stdout: String(ex?.stdout || ""),
            stderr: String(ex?.stderr || ""),
            machine: ex?.machine || "devin-vm",
            vmSessionId,
          };
        } finally {
          if (vm && typeof runner.archive === "function") {
            runner.archive(vmSessionId, vm);
          }
        }
      } catch (err) {
        if (vm && typeof runner.archive === "function") {
          try {
            runner.archive(vmSessionId, vm);
          } catch {}
        }
        throw err;
      }
    })();
    return runResult;
  }

  if (typeof runner === "function") {
    const cleanups = [];
    const registerCleanup = (fn) => {
      if (typeof fn === "function") cleanups.push(fn);
    };
    const runCleanupsSync = () => {
      while (cleanups.length) {
        const fn = cleanups.pop();
        fn();
      }
    };
    const runCleanupsAsync = async () => {
      while (cleanups.length) {
        const fn = cleanups.pop();
        await fn();
      }
    };
    let out;
    try {
      out = runner({ cmd, cwd, offload: "devin-vm", timeoutMs, env, devinBridge, registerCleanup });
    } catch (err) {
      runCleanupsSync();
      throw err;
    }
    if (out && typeof out.then === "function") {
      return out.then(
        async (res) => {
          await runCleanupsAsync();
          return {
            exitCode: res?.exitCode ?? res?.exit_code ?? -1,
            stdout: String(res?.stdout || ""),
            stderr: String(res?.stderr || ""),
            machine: res?.machine || "devin-vm",
            vmSessionId: res?.vmSessionId || null,
          };
        },
        async (err) => {
          await runCleanupsAsync();
          throw err;
        },
      );
    }
    runCleanupsSync();
    return {
      exitCode: out?.exitCode ?? out?.exit_code ?? -1,
      stdout: String(out?.stdout || ""),
      stderr: String(out?.stderr || ""),
      machine: out?.machine || "devin-vm",
      vmSessionId: out?.vmSessionId || null,
    };
  }

  if (!devinBridge || !existsSync(devinBridge)) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: devinBridge
        ? `Devin VM bridge not found at "${devinBridge}"`
        : "Devin VM bridge not configured (set OVERDRIVE_DEVIN_VM_BRIDGE or ~/.overdrive/config.json)",
      machine: "devin-vm",
      vmArchived: false,
    };
  }

  let sessionId = null;
  let archived = false;
  try {
    const spawnRes = callDevinBridgeSync(
      devinBridge,
      "vm_spawn",
      { platform: opts.platform || "linux", mode: opts.mode || "drs-sandbox", ...(opts.repo ? { repo: opts.repo } : {}) },
      { timeoutMs, env },
    );
    sessionId = spawnRes.session_id || spawnRes.sessionId || null;
    if (!sessionId) {
      throw new Error("Devin VM spawn returned no session_id");
    }
    const execRes = callDevinBridgeSync(
      devinBridge,
      "vm_exec",
      {
        session_id: sessionId,
        command: cmd,
        timeout_sec: Math.max(30, Math.min(600, Math.ceil(timeoutMs / 1000))),
      },
      { timeoutMs, env },
    );
    return {
      exitCode: execRes.exit_code ?? execRes.exitCode ?? -1,
      stdout: String(execRes.stdout || ""),
      stderr: String(execRes.stderr || ""),
      machine: "devin-vm",
      vmSessionId: sessionId,
      vmArchived: true,
    };
  } finally {
    if (sessionId) {
      try {
        callDevinBridgeSync(devinBridge, "vm_archive", { session_id: sessionId }, { timeoutMs: 30_000, env });
        archived = true;
      } catch {}
    }
  }
}

/**
 * Execute a verification/gate command with semaphore slot enforcement and offload routing:
 * - "local" / "auto" -> local-heavy slot, PowerShell/sh
 * - "aipc" -> aipc slot (limit 2), python aipc.py auto -- cmd (fallback local if missing)
 * - "aipc-gpu" -> aipc-gpu slot (limit 1), python aipc.py auto --gpu -- cmd (fallback local if missing)
 * - "devin-vm" -> devin-vm slot (limit 4), devinBridge / runner with guaranteed try/finally VM archive
 */
function parseHeldSlots(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(String(rawValue));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) =>
        e &&
        typeof e.token === "string" &&
        Number.isInteger(e.pid) &&
        e.pid > 0 &&
        isPidAlive(e.pid),
    );
  } catch {
    return [];
  }
}

export function runWithCompute(
  cmd,
  {
    cwd = process.cwd(),
    offload = "auto",
    timeoutMs = 120_000,
    env = {},
    aipcScript = defaultAipcScript(),
    devinBridge = defaultDevinVmBridge(),
    runner = null,
    lockDir = undefined,
    waitMs = undefined,
    staleMs = 600_000,
    limit = undefined,
    reentrant = true,
    platform = "linux",
    mode = "drs-sandbox",
    repo = undefined,
  } = {},
) {
  const t0 = Date.now();
  const mergedEnv = { ...process.env, ...env };
  const normOffload = String(offload || "auto");
  const aipcDisabled = mergedEnv.OVERDRIVE_DISABLE_AIPC === "1";
  const aipcScriptReady = Boolean(aipcScript && existsSync(aipcScript));
  const autoWantsAipc = normOffload === "auto" && !aipcDisabled && aipcScriptReady;
  const isAipc = normOffload === "aipc" || normOffload === "aipc-gpu" || autoWantsAipc;
  const aipcAvailable = isAipc && aipcScriptReady;
  const resolvedAipcMode = normOffload === "aipc-gpu" ? "aipc-gpu" : "aipc";
  const effectiveOffload =
    normOffload === "devin-vm"
      ? "devin-vm"
      : isAipc
        ? aipcAvailable || runner
          ? resolvedAipcMode
          : "local"
        : "local";

  const slotKey =
    effectiveOffload === "aipc"
      ? "aipc"
      : effectiveOffload === "aipc-gpu"
        ? "aipc-gpu"
        : effectiveOffload === "devin-vm"
          ? "devin-vm"
          : "local-heavy";

  const finalize = (raw) => {
    const stdout = String(raw?.stdout || "");
    const stderr = String(raw?.stderr || "");
    const exitCode = Number.isInteger(raw?.exitCode) ? raw.exitCode : -1;
    return {
      ok: exitCode === 0,
      exitCode,
      durationMs: Date.now() - t0,
      machine: raw?.machine || effectiveOffload,
      offload: effectiveOffload,
      slotKey,
      stdout,
      stderr,
      stdoutTail: stdout.slice(-4000),
      stderrTail: stderr.slice(-4000),
      ...(raw?.vmSessionId ? { vmSessionId: raw.vmSessionId } : {}),
      ...(raw?.vmArchived !== undefined ? { vmArchived: raw.vmArchived } : {}),
    };
  };

  const effectiveWaitMs = waitMs ?? Math.min(Math.max(3000, timeoutMs), 60_000);
  const effectiveLockDir = path.resolve(lockDir || mergedEnv.OVERDRIVE_LOCK_DIR || defaultLockDir());
  const normLockRoot = process.platform === "win32" ? effectiveLockDir.toLowerCase() : effectiveLockDir;
  const slotToken = `${slotKey}@${normLockRoot}`;
  const aliveHeld = parseHeldSlots(mergedEnv.OVERDRIVE_HELD_SLOTS);

  const executeBody = () => {
    if (effectiveOffload === "devin-vm") {
      const res = runDevinVmWithRunnerOrBridge(cmd, {
        cwd,
        timeoutMs,
        env: mergedEnv,
        devinBridge,
        runner,
        platform,
        mode,
        repo,
      });
      return res && typeof res.then === "function" ? res.then(finalize) : finalize(res);
    }

    if (typeof runner === "function") {
      const res = runner({
        cmd,
        cwd,
        offload: effectiveOffload,
        slotKey,
        timeoutMs,
        env: mergedEnv,
        aipcScript,
        devinBridge,
      });
      return res && typeof res.then === "function" ? res.then(finalize) : finalize(res);
    }

    if ((effectiveOffload === "aipc" || effectiveOffload === "aipc-gpu") && aipcAvailable) {
      const argv = [aipcScript, "auto", ...(effectiveOffload === "aipc-gpu" ? ["--gpu"] : []), "--", cmd];
      const r = spawnSync("python", argv, {
        cwd,
        env: mergedEnv,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: timeoutMs,
      });
      return finalize({
        exitCode: r.status ?? -1,
        stdout: String(r.stdout || ""),
        stderr: String(r.stderr || "") + (r.error ? `\n${r.error.message}` : ""),
        machine: effectiveOffload === "aipc-gpu" ? "aipc-gpu" : "aipc-auto",
      });
    }

    return finalize(runLocalShell(cmd, { cwd, timeoutMs, env: mergedEnv }));
  };

  if (
    reentrant !== false &&
    aliveHeld.some((e) => e.token === slotToken && isSlotStillHeldByPid(effectiveLockDir, slotKey, limit, e.pid))
  ) {
    mergedEnv.OVERDRIVE_HELD_SLOTS = JSON.stringify(aliveHeld);
    return executeBody();
  }

  return withSlot(slotKey, { lockDir: effectiveLockDir, waitMs: effectiveWaitMs, staleMs, limit }, () => {
    const nextHeld = aliveHeld.some((e) => e.token === slotToken && e.pid === process.pid)
      ? aliveHeld
      : [...aliveHeld, { token: slotToken, pid: process.pid }];
    mergedEnv.OVERDRIVE_HELD_SLOTS = JSON.stringify(nextHeld);
    return executeBody();
  });
}
