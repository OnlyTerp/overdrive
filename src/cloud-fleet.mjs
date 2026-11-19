import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeRelPattern } from "./partition.mjs";
import { CLOUD_PROVIDERS } from "./ui-contracts.mjs";

export const DEFAULT_CLAUDE_CLOUD_CAPS = Object.freeze({
  "claude-opus-5-5": 10,
  "claude-sonnet-5-5": 10,
  "fable-2": 20,
});

import {
  defaultCloudLedgerDir as resolveDefaultCloudLedgerDir,
  defaultConnectAnythingBin,
  defaultDevinVmBridge,
} from "./paths.mjs";

export const DEFAULT_CONNECT_ANYTHING_BIN = defaultConnectAnythingBin();
export const DEFAULT_DEVIN_VM_BRIDGE = defaultDevinVmBridge();

export function defaultCloudLedgerDir() {
  return resolveDefaultCloudLedgerDir();
}

export function defaultClaudeCloudScript() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, ".agents", "skills", "claude-cloud", "claude-cloud.ps1");
}

const SECRET_CHECK_PATTERNS = [
  { name: "private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|(?=$))/g },
  { name: "api_key_sk", re: /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "devin_token", re: /\bdevin-session-token\$[^\s"']+/g },
  {
    name: "env_secret_assignment",
    re: /\b[A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|AUTH_TOKEN|OAUTH_TOKEN|PRIVATE_KEY|PASSWORD|SECRET|TOKEN)\s*=\s*['"]?[^\s'"`]{6,}['"]?/g,
  },
];

const DOTENV_FILE_RE = /(?:^|[\s"'`\\/])\.env(?:\.(?:local|production|prod|development|dev|staging|test))?(?=$|[\s"'`:,])/i;

function sanitizeKeyPart(raw) {
  return String(raw || "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 48) || "unknown";
}

function attemptRecordPath(missionSlug, laneId, provider, ledgerDir) {
  const hash = createHash("sha256")
    .update(`${String(missionSlug)}\0${String(laneId)}\0${String(provider)}`)
    .digest("hex")
    .slice(0, 12);
  const file = `${sanitizeKeyPart(missionSlug)}__${sanitizeKeyPart(laneId)}__${sanitizeKeyPart(provider)}__${hash}.json`;
  return path.join(ledgerDir, file);
}

/** Scan outbound prompt/attachments for `.env` payloads or unredacted private tokens. */
export function scanForSecrets(text, attachFiles = []) {
  const hits = [];
  const str = String(text || "");
  for (const { name, re } of SECRET_CHECK_PATTERNS) {
    const rx = new RegExp(re.source, re.flags.replace("g", ""));
    if (rx.test(str)) hits.push(name);
  }
  if (DOTENV_FILE_RE.test(str)) {
    hits.push("dotenv_reference");
  }
  for (const f of Array.isArray(attachFiles) ? attachFiles : []) {
    const base = path.basename(String(f || "")).toLowerCase();
    if (base === ".env" || (base.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(base))) {
      hits.push(`dotenv_file:${base}`);
    }
  }
  return Array.from(new Set(hits));
}

/** Redact recognized credential patterns from outbound text. */
export function redactSecrets(text) {
  let out = String(text || "");
  for (const { re } of SECRET_CHECK_PATTERNS) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    out = out.replace(new RegExp(re.source, flags), "<redacted>");
  }
  return out;
}

function resolveClaudeCap(model, explicitCap) {
  if (typeof explicitCap === "number" && Number.isFinite(explicitCap) && explicitCap > 0) {
    return explicitCap;
  }
  const m = String(model || "claude-opus-5-5").toLowerCase();
  if (m.includes("fable")) return DEFAULT_CLAUDE_CLOUD_CAPS["fable-2"];
  if (m.includes("sonnet")) return DEFAULT_CLAUDE_CLOUD_CAPS["claude-sonnet-5-5"];
  return DEFAULT_CLAUDE_CLOUD_CAPS["claude-opus-5-5"];
}

function normalizeClaudeModelArg(model) {
  const m = String(model || "claude-opus-5-5").trim();
  const lower = m.toLowerCase();
  if (lower === "fable" || lower === "fable-2") return "fable";
  if (lower === "opus" || lower === "claude-opus-5-5") return "opus";
  if (lower === "sonnet" || lower === "claude-sonnet-5-5") return "sonnet";
  return m;
}

function defaultRunner(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: opts.timeout ?? 180_000,
    ...opts,
  });
}

function tryGitRemoteUrl(repoRoot) {
  if (!repoRoot || !existsSync(repoRoot)) return null;
  const r = spawnSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0) return null;
  const url = String(r.stdout || "").trim();
  return url || null;
}

function parseJsonSafe(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const lines = s.split(/\r?\n/).reverse();
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith("{") && t.endsWith("}")) {
        try {
          return JSON.parse(t);
        } catch {}
      }
    }
    return null;
  }
}

/**
 * Atomically claim a single-attempt idempotency record (`reserved`) on disk BEFORE spawning a billed cloud turn.
 * Throws `CLOUD_SPAWN_ALREADY_ATTEMPTED` on duplicate claim unless `forceRetry: true`.
 */
export function claimSingleAttemptKey(
  missionSlug,
  laneId,
  provider,
  ledgerDir = defaultCloudLedgerDir(),
  { forceRetry = false, metadata = {} } = {},
) {
  if (!missionSlug || !laneId || !provider) {
    throw new Error("claimSingleAttemptKey requires missionSlug, laneId, and provider.");
  }
  const resolvedDir = path.resolve(ledgerDir || defaultCloudLedgerDir());
  mkdirSync(resolvedDir, { recursive: true });
  const recordPath = attemptRecordPath(missionSlug, laneId, provider, resolvedDir);
  const key = `${missionSlug}:${laneId}:${provider}`;
  const now = new Date().toISOString();

  let previous = null;
  if (existsSync(recordPath)) {
    try {
      previous = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch {
      previous = { key, status: "unknown" };
    }
    if (!forceRetry) {
      const err = new Error(
        `CLOUD_SPAWN_ALREADY_ATTEMPTED: "${key}" already has ledger status "${previous?.status || "reserved"}" at ${recordPath}. Never auto-retried; pass forceRetry: true to explicitly override.`,
      );
      err.code = "CLOUD_SPAWN_ALREADY_ATTEMPTED";
      err.attemptKey = key;
      err.recordPath = recordPath;
      err.existingRecord = previous;
      throw err;
    }
  }

  const record = {
    key,
    missionSlug: String(missionSlug),
    laneId: String(laneId),
    provider: String(provider),
    status: "reserved",
    retryCount: previous ? Number(previous.retryCount || 0) + 1 : 0,
    forcedRetry: Boolean(previous && forceRetry),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    ...metadata,
  };

  writeFileSync(recordPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    flag: forceRetry ? "w" : "wx",
  });

  const update = (patch = {}) => {
    const next = {
      ...record,
      ...patch,
      key,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(recordPath, JSON.stringify(next, null, 2), "utf8");
    Object.assign(record, next);
    return next;
  };

  return {
    ok: true,
    claimed: true,
    key,
    attemptKey: key,
    status: record.status,
    recordPath,
    record,
    update,
  };
}

/**
 * Dispatch a cloud worker for one lane with hard no-double-spend ledger protection,
 * `cloud/<slug>-<lane>` branch instruction binding, and strict secret redaction checks.
 */
export function dispatchCloudWorker(
  store,
  missionId,
  laneId,
  {
    provider = "claude-cloud",
    branchName,
    outputBranch,
    account,
    model,
    prompt,
    repo,
    attachFiles = [],
    cap,
    forceRetry = false,
    dryRun = false,
    redactSecrets: allowRedact = false,
    ledgerDir = defaultCloudLedgerDir(),
    runner,
    scriptPath,
    connectAnythingPath = defaultConnectAnythingBin() || "connect-anything",
    bridgePath = defaultDevinVmBridge(),
    command = undefined,
    cwd = undefined,
    platform = "linux",
    mode = "acp-idle",
    keepAlive = false,
    timeoutMs = 180_000,
  } = {},
) {
  if (!CLOUD_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported cloud provider "${provider}". Expected one of: ${CLOUD_PROVIDERS.join(", ")}`);
  }
  const mission = store?.getMission ? store.getMission(missionId) : null;
  const lane = mission?.lanes?.find((l) => l.id === laneId) || null;
  const slug = mission?.slug || sanitizeKeyPart(missionId);
  const missionKey = mission?.id || missionId;
  if (!missionKey || !laneId) {
    throw new Error("dispatchCloudWorker requires missionId and laneId.");
  }

  const targetOutputBranch =
    outputBranch ||
    (branchName && String(branchName).startsWith("cloud/") ? String(branchName) : `cloud/${slug}-${laneId}`);
  const baseBranch = branchName && !String(branchName).startsWith("cloud/") ? String(branchName) : "main";

  const basePrompt =
    String(prompt || "").trim() ||
    String(lane?.brief || "").trim() ||
    String(lane?.title || "").trim() ||
    (provider === "devin-vm" && command ? `Execute in Devin VM: ${command}` : "");
  if (!basePrompt) {
    throw new Error(`dispatchCloudWorker requires a non-empty prompt for lane "${laneId}".`);
  }

  const secretHits = scanForSecrets(`${basePrompt}\n${command || ""}`, attachFiles);
  if (secretHits.length > 0 && !allowRedact) {
    const err = new Error(
      `CLOUD_SECRET_REDACTION_BLOCKED: refusing to forward secret/dotenv material (${secretHits.join(", ")}) to cloud provider "${provider}".`,
    );
    err.code = "CLOUD_SECRET_REDACTION_BLOCKED";
    err.hits = secretHits;
    throw err;
  }
  if (allowRedact && secretHits.some((h) => h.startsWith("dotenv"))) {
    const err = new Error(
      `CLOUD_SECRET_REDACTION_BLOCKED: refusing to forward .env file or dotenv reference to cloud provider "${provider}".`,
    );
    err.code = "CLOUD_SECRET_REDACTION_BLOCKED";
    err.hits = secretHits;
    throw err;
  }

  const safePrompt = allowRedact ? redactSecrets(basePrompt) : basePrompt;
  const ownershipText = lane?.ownedGlobs?.length
    ? `\n- Owned files ONLY: ${lane.ownedGlobs.join(", ")}. Never edit frozen shared contracts.`
    : "\n- Stay strictly inside your assigned ownedGlobs and never modify frozen shared contracts.";
  const boundPrompt =
    `${safePrompt}\n\n---\nOVERDRIVE CLOUD WORKER INSTRUCTIONS:\n` +
    `- Push your completed changes ONLY to a new branch named \`${targetOutputBranch}\` (never push or merge to main/master).` +
    ownershipText +
    `\n- End with changed files and exact verification command output.`;

  const resolvedLedgerDir = path.resolve(ledgerDir || defaultCloudLedgerDir());
  const expectedPath = attemptRecordPath(missionKey, laneId, provider, resolvedLedgerDir);
  if (!forceRetry && existsSync(expectedPath)) {
    const err = new Error(
      `CLOUD_SPAWN_ALREADY_ATTEMPTED: "${missionKey}:${laneId}:${provider}" already exists at ${expectedPath}. Never auto-retried; pass forceRetry: true to explicitly override.`,
    );
    err.code = "CLOUD_SPAWN_ALREADY_ATTEMPTED";
    err.recordPath = expectedPath;
    throw err;
  }

  // Guard against duplicate claims under either missionId or mission.slug.
  if (!forceRetry && mission?.slug && mission.slug !== missionKey) {
    const altPath = attemptRecordPath(mission.slug, laneId, provider, resolvedLedgerDir);
    if (existsSync(altPath)) {
      const err = new Error(
        `CLOUD_SPAWN_ALREADY_ATTEMPTED: "${mission.slug}:${laneId}:${provider}" already attempted at ${altPath}.`,
      );
      err.code = "CLOUD_SPAWN_ALREADY_ATTEMPTED";
      err.recordPath = altPath;
      throw err;
    }
  }

  const resolvedModel = model || lane?.worker?.model || (provider === "claude-cloud" ? "claude-opus-5-5" : undefined);
  const resolvedCap = provider === "claude-cloud" ? resolveClaudeCap(resolvedModel, cap) : null;
  const repoTarget = repo || tryGitRemoteUrl(mission?.repoRoot) || mission?.repoRoot || "local-repo";
  const claudeScript = scriptPath || defaultClaudeCloudScript();
  const useClaudeScript = provider === "claude-cloud" && (Boolean(scriptPath) || existsSync(claudeScript));

  let cmd;
  let args;
  if (provider === "devin-vm") {
    cmd = process.execPath;
    args = [bridgePath || "devin-vm", "call", "vm_spawn", "--json", JSON.stringify({ platform, mode })];
  } else if (useClaudeScript) {
    const psExe = process.platform === "win32" ? "powershell.exe" : "pwsh";
    args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      claudeScript,
      "spawn",
      "-Repo",
      repoTarget,
      "-Branch",
      baseBranch,
      "-Model",
      normalizeClaudeModelArg(resolvedModel),
      "-Prompt",
      boundPrompt,
      "-Name",
      `${slug}-${laneId}`.slice(0, 48),
      "-Cap",
      String(resolvedCap),
    ];
    if (account) args.push("-Route", String(account));
    cmd = psExe;
  } else {
    cmd = process.execPath;
    args = [connectAnythingPath, "spawn", provider];
    if (repoTarget && repoTarget !== "local-repo") args.push("--repo", String(repoTarget));
    if (baseBranch) args.push("--branch", baseBranch);
    if (resolvedModel) args.push("--model", String(resolvedModel));
    if (account) args.push("--account", String(account));
    args.push("--wait", "0", boundPrompt);
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldSpawn: true,
      attemptKey: `${missionKey}:${laneId}:${provider}`,
      ledgerPath: expectedPath,
      ledgerWritten: false,
      provider,
      model: resolvedModel || null,
      cap: resolvedCap,
      account: account || null,
      outputBranch: targetOutputBranch,
      baseBranch,
      repo: repoTarget,
      secretHits,
      commandPreview: { cmd, argsCount: args.length, runnerKind: provider === "devin-vm" ? "devin-vm" : useClaudeScript ? "claude-cloud.ps1" : "connect-anything" },
      boundPrompt,
    };
  }

  const claim = claimSingleAttemptKey(missionKey, laneId, provider, ledgerDir, {
    forceRetry,
    metadata: {
      missionSlug: slug,
      outputBranch: targetOutputBranch,
      baseBranch,
      model: resolvedModel || null,
      account: account || null,
      cap: resolvedCap,
    },
  });

  if (provider === "devin-vm") {
    let vmSession = null;
    let execOut = null;
    let vmArchived = false;
    try {
      const vmRepo = /^https?:|^git@/.test(String(repoTarget || "")) ? String(repoTarget) : "";
      vmSession = spawnDevinSandbox({
        platform,
        mode,
        repo: vmRepo,
        bridgePath,
        runner,
        timeoutMs,
      });
      const sessionId = vmSession?.session_id || vmSession?.id;
      if (!sessionId) {
        throw new Error(`devin-vm vm_spawn did not return session_id: ${JSON.stringify(vmSession)}`);
      }
      if (command) {
        execOut = execInDevinSandbox(sessionId, command, {
          cwd,
          bridgePath,
          runner,
          timeoutMs,
        });
      }
      const execExit = execOut?.exit_code ?? execOut?.exitCode;
      if (execOut && Number.isInteger(execExit) && execExit !== 0) {
        throw new Error(`devin-vm command exited with ${execExit}: ${(execOut.stderr || execOut.stdout || "").slice(-500)}`);
      }
      if (!keepAlive) {
        archiveDevinSandbox(sessionId, { bridgePath, runner, timeoutMs: 60_000 });
        vmArchived = true;
      }
      const jobRef = {
        provider: "devin-vm",
        sessionId,
        mode,
        platform,
        vmArchived,
        outputBranch: targetOutputBranch,
        scriptPath: bridgePath,
      };
      const finalRecord = claim.update({
        status: "dispatched",
        dispatchedAt: new Date().toISOString(),
        jobRef,
      });
      if (store?.recordEvent && mission) {
        store.recordEvent(
          mission.id,
          "coordinator",
          "cloud_dispatched",
          {
            laneId,
            provider: "devin-vm",
            model: resolvedModel || "devin-vm",
            branchName: targetOutputBranch,
            attemptKey: claim.attemptKey,
            jobRef,
            status: lane?.status || "active",
          },
          {
            laneId,
            actor: `devin-vm/${mode}`,
            summary: `Executed devin-vm sandbox ${sessionId} for lane ${laneId}`,
          },
        );
      }
      return {
        ok: true,
        attemptKey: claim.attemptKey,
        ledgerPath: claim.recordPath,
        status: finalRecord.status,
        provider: "devin-vm",
        model: resolvedModel || "devin-vm",
        cap: null,
        outputBranch: targetOutputBranch,
        boundPrompt,
        jobRef,
        vmSession,
        vmExec: execOut,
        vmArchived,
        stdout: execOut?.stdout || "",
        raw: execOut || vmSession,
      };
    } catch (err) {
      const sid = vmSession?.session_id || vmSession?.id;
      if (sid && !vmArchived && !keepAlive) {
        try {
          archiveDevinSandbox(sid, { bridgePath, runner, timeoutMs: 60_000 });
          vmArchived = true;
        } catch {}
      }
      claim.update({ status: "failed_no_retry", error: String(err?.message || err).slice(0, 1500), vmArchived });
      const wrapped = new Error(`Cloud spawn failed for devin-vm (${laneId}) [no auto-retry]: ${err?.message || err}`);
      wrapped.code = "CLOUD_SPAWN_FAILED_NO_RETRY";
      wrapped.ledgerPath = claim.recordPath;
      wrapped.vmArchived = vmArchived;
      throw wrapped;
    }
  }

  const exec = typeof runner === "function" ? runner : defaultRunner;
  if (!useClaudeScript && !runner && !existsSync(connectAnythingPath)) {
    claim.update({ status: "failed_no_retry", error: `Cloud runner missing: ${connectAnythingPath}` });
    throw new Error(`Cloud runner not found at "${connectAnythingPath}".`);
  }

  let res;
  try {
    res = exec(cmd, args, {
      cwd: lane?.worktreePath && existsSync(lane.worktreePath) ? lane.worktreePath : mission?.repoRoot || process.cwd(),
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
    });
  } catch (err) {
    claim.update({ status: "failed_no_retry", error: String(err?.message || err) });
    throw err;
  }

  const exitCode = res?.status ?? res?.exitCode ?? (res?.error ? 1 : 0);
  const stdout = String(res?.stdout || "");
  const stderr = String(res?.stderr || "");
  const parsed = parseJsonSafe(stdout);

  if (res?.error || exitCode !== 0 || (parsed && ["error", "no_route", "run_failed"].includes(parsed.status))) {
    const reason = parsed?.error || parsed?.status || res?.error?.message || stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    claim.update({ status: "failed_no_retry", exitCode, error: String(reason).slice(0, 1500), rawResponse: parsed || null });
    const err = new Error(`Cloud spawn failed for ${provider} (${laneId}) [no auto-retry]: ${reason}`);
    err.code = "CLOUD_SPAWN_FAILED_NO_RETRY";
    err.ledgerPath = claim.recordPath;
    throw err;
  }

  const groupIdMatch = stdout.match(/\b(g-[A-Za-z0-9-]+)\b/);
  const urlMatch = stdout.match(/https:\/\/\S+/);
  const jobRef = {
    provider,
    jobId: parsed?.jobId || parsed?.id || groupIdMatch?.[1] || null,
    triggerId: parsed?.trigger_id || parsed?.triggerId || null,
    sessionId: parsed?.session_id || parsed?.sessionId || null,
    route: parsed?.route || account || null,
    account: parsed?.account || account || null,
    url: parsed?.link || parsed?.url || urlMatch?.[0] || null,
    model: parsed?.model || resolvedModel || null,
    cap: resolvedCap,
    outputBranch: targetOutputBranch,
    scriptPath: useClaudeScript ? claudeScript : connectAnythingPath,
  };

  const finalRecord = claim.update({
    status: "dispatched",
    dispatchedAt: new Date().toISOString(),
    jobRef,
  });

  if (store?.recordEvent && mission) {
    store.recordEvent(
      mission.id,
      "coordinator",
      "cloud_dispatched",
      {
        laneId,
        provider,
        model: jobRef.model,
        cap: jobRef.cap,
        branchName: targetOutputBranch,
        attemptKey: claim.attemptKey,
        jobRef,
        status: lane?.status || "active",
      },
      {
        laneId,
        actor: `${provider}/${jobRef.model || "default"}`,
        summary: `Dispatched cloud lane ${laneId} via ${provider} -> ${targetOutputBranch}`,
      },
    );
  }

  return {
    ok: true,
    attemptKey: claim.attemptKey,
    ledgerPath: claim.recordPath,
    status: finalRecord.status,
    provider,
    model: jobRef.model,
    cap: resolvedCap,
    outputBranch: targetOutputBranch,
    boundPrompt,
    jobRef,
    raw: parsed || stdout.trim(),
  };
}

/**
 * Poll a running cloud worker job (claude-cloud.ps1 status or connect-anything job).
 */
export function pollCloudJob(
  jobRef,
  { runner, scriptPath, connectAnythingPath = DEFAULT_CONNECT_ANYTHING_BIN, timeoutMs = 60_000 } = {},
) {
  const ref = typeof jobRef === "string" ? { jobId: jobRef } : { ...(jobRef || {}) };
  const provider = ref.provider || (ref.triggerId || ref.trigger_id ? "claude-cloud" : "connect-anything");
  const triggerId = ref.triggerId || ref.trigger_id || null;
  const sessionId = ref.sessionId || ref.session_id || null;
  const jobId = ref.jobId || ref.id || null;
  const route = ref.route || ref.account || null;

  const exec = typeof runner === "function" ? runner : defaultRunner;
  const claudeScript = scriptPath || ref.scriptPath || defaultClaudeCloudScript();

  if (provider === "claude-cloud" && triggerId && (runner || existsSync(claudeScript))) {
    const psExe = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", claudeScript, "status", triggerId];
    if (route) args.push("-Route", String(route));
    const res = exec(psExe, args, { shell: false, windowsHide: true, encoding: "utf8", timeout: timeoutMs });
    const exitCode = res?.status ?? res?.exitCode ?? (res?.error ? 1 : 0);
    const parsed = parseJsonSafe(res?.stdout);
    if (res?.error || exitCode !== 0 || parsed?.status === "error") {
      return {
        ok: false,
        provider,
        status: "failed",
        triggerId,
        sessionId,
        error: parsed?.error || res?.error?.message || String(res?.stderr || res?.stdout || "").trim(),
        raw: parsed || String(res?.stdout || ""),
      };
    }
    const firstRun = Array.isArray(parsed?.runs) ? parsed.runs[0] : null;
    const trig = parsed?.trigger || {};
    const done = Boolean(firstRun?.done || ["completed", "succeeded", "done"].includes(String(trig.last_run_status || "").toLowerCase()));
    const failed = Boolean(trig.failure_reason || ["failed", "error", "cancelled"].includes(String(firstRun?.status || trig.last_run_status || "").toLowerCase()));
    return {
      ok: true,
      provider,
      status: failed ? "failed" : done ? "done" : "running",
      triggerId,
      sessionId: firstRun?.session_id || trig.last_run_session || sessionId,
      url: firstRun?.link || ref.url || null,
      costUsd: firstRun?.cost_usd ?? null,
      error: trig.failure_reason || null,
      runs: parsed?.runs || [],
      raw: parsed,
    };
  }

  const targetId = jobId || sessionId || triggerId;
  if (!targetId) {
    throw new Error("pollCloudJob requires a jobId, triggerId, or sessionId.");
  }
  const res = exec(process.execPath, [connectAnythingPath, "job", targetId, "--json"], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const exitCode = res?.status ?? res?.exitCode ?? (res?.error ? 1 : 0);
  const parsed = parseJsonSafe(res?.stdout);
  if (res?.error || exitCode !== 0) {
    return {
      ok: false,
      provider,
      status: "failed",
      jobId: targetId,
      error: res?.error?.message || String(res?.stderr || res?.stdout || "").trim(),
      raw: parsed || String(res?.stdout || ""),
    };
  }
  if (parsed && typeof parsed === "object") {
    return {
      ok: true,
      provider,
      status: parsed.status || "running",
      jobId: parsed.id || targetId,
      url: parsed.url || ref.url || null,
      result: parsed.result ?? null,
      error: parsed.error ?? null,
      members: parsed.members || null,
      raw: parsed,
    };
  }
  return {
    ok: true,
    provider,
    status: /\bdone\b/i.test(String(res?.stdout || "")) ? "done" : "running",
    jobId: targetId,
    raw: String(res?.stdout || "").trim(),
  };
}

function extractPatchTouchedPaths(patchText) {
  const paths = new Set();
  for (const line of String(patchText || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      if (m) {
        paths.add(m[1]);
        paths.add(m[2]);
      }
    } else if (line.startsWith("--- a/") || line.startsWith("+++ b/")) {
      paths.add(line.slice(6).trim());
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      paths.add(line.replace(/^rename (?:from|to)\s+/, "").trim());
    }
  }
  const normalized = [];
  for (const raw of paths) {
    if (!raw || raw === "/dev/null") continue;
    try {
      normalized.push(normalizeRelPattern(raw));
    } catch {
      normalized.push(raw.replaceAll("\\", "/"));
    }
  }
  return Array.from(new Set(normalized));
}

function assertNoSharedContractMutation(touchedFiles, contracts = [], sourceDesc = "artifact") {
  if (!Array.isArray(contracts) || contracts.length === 0) return;
  const contractPaths = new Set(
    contracts.map((c) => {
      try {
        return normalizeRelPattern(c.path);
      } catch {
        return String(c.path || "").replaceAll("\\", "/");
      }
    }),
  );
  const violations = touchedFiles.filter((f) => contractPaths.has(f));
  if (violations.length > 0) {
    const err = new Error(
      `CONTRACT_TAMPERED: ${sourceDesc} attempts to modify frozen sharedContract(s): ${violations.join(", ")}`,
    );
    err.code = "CONTRACT_TAMPERED";
    err.contracts = violations;
    throw err;
  }
}

/**
 * Ingest either a SHA-256 verified `.patch` artifact OR a `cloud/*` git branch into `lane.worktreePath`
 * without altering any frozen `sharedContracts`. Records `cloud_ingested` on `store` when provided.
 */
export function ingestCloudArtifact(
  store,
  missionId,
  laneId,
  { branchRef, patchPath, patchText, expectedSha256, runner, remote = "origin" } = {},
) {
  const mission = store?.getMission ? store.getMission(missionId) : null;
  const lane = mission?.lanes?.find((l) => l.id === laneId) || null;
  if (store && !mission) {
    throw new Error(`Unknown mission "${missionId}".`);
  }
  if (mission && !lane) {
    throw new Error(`Unknown lane "${laneId}" in mission "${mission.id}".`);
  }
  const targetDir = lane?.worktreePath && existsSync(lane.worktreePath) ? lane.worktreePath : mission?.repoRoot || process.cwd();
  const exec = typeof runner === "function" ? runner : defaultRunner;

  if (patchPath !== undefined || patchText !== undefined) {
    let patchBuf;
    if (patchText !== undefined && patchText !== null) {
      patchBuf = Buffer.isBuffer(patchText) ? patchText : Buffer.from(String(patchText), "utf8");
    } else {
      if (!patchPath || !existsSync(patchPath)) {
        throw new Error(`Patch artifact not found: "${patchPath}"`);
      }
      patchBuf = readFileSync(patchPath);
    }

    const actualSha256 = createHash("sha256").update(patchBuf).digest("hex");
    if (!expectedSha256 || typeof expectedSha256 !== "string") {
      const err = new Error("PATCH_SHA_MISMATCH: expectedSha256 is mandatory for patch artifact ingestion.");
      err.code = "PATCH_SHA_MISMATCH";
      err.actualSha256 = actualSha256;
      throw err;
    }
    const cleanExpected = expectedSha256.trim().toLowerCase();
    if (actualSha256 !== cleanExpected) {
      const err = new Error(`PATCH_SHA_MISMATCH: expected ${cleanExpected}, got ${actualSha256}`);
      err.code = "PATCH_SHA_MISMATCH";
      err.expectedSha256 = cleanExpected;
      err.actualSha256 = actualSha256;
      throw err;
    }

    const patchStr = patchBuf.toString("utf8");
    const touchedFiles = extractPatchTouchedPaths(patchStr);
    assertNoSharedContractMutation(touchedFiles, mission?.contracts || [], `patch "${patchPath || "inline"}"`);

    const res = exec("git", ["-C", targetDir, "apply", "--whitespace=nowarn", "-"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      input: patchStr,
    });
    const exitCode = res?.status ?? res?.exitCode ?? (res?.error ? 1 : 0);
    if (res?.error || exitCode !== 0) {
      throw new Error(`git apply failed in "${targetDir}": ${res?.error?.message || res?.stderr || res?.stdout || `exit ${exitCode}`}`);
    }

    if (store?.recordEvent && mission) {
      store.recordEvent(
        mission.id,
        "coordinator",
        "cloud_ingested",
        {
          laneId,
          mode: "patch",
          patchPath: patchPath || null,
          sha256: actualSha256,
          touchedFiles,
          worktreePath: targetDir,
          status: lane?.status || "active",
        },
        {
          laneId,
          summary: `Ingested SHA-256 verified cloud patch into lane ${laneId} (${touchedFiles.length} file(s))`,
        },
      );
    }

    return {
      ok: true,
      mode: "patch",
      missionId: mission?.id || missionId,
      laneId,
      sha256: actualSha256,
      touchedFiles,
      targetDir,
    };
  }

  if (branchRef) {
    const cleanRef = String(branchRef).trim();
    if (!cleanRef || cleanRef.startsWith("-") || /\s/.test(cleanRef)) {
      throw new Error(`Invalid cloud branchRef "${branchRef}".`);
    }
    const isCloudRef =
      cleanRef.startsWith("cloud/") ||
      cleanRef.startsWith("refs/heads/cloud/") ||
      cleanRef.startsWith(`${remote}/cloud/`) ||
      /^remotes\/[^/]+\/cloud\//.test(cleanRef);
    if (!isCloudRef) {
      throw new Error(`Cloud branch ingest requires a cloud/* ref; got "${branchRef}".`);
    }

    // Verify if ref resolves locally; otherwise attempt git fetch from remote.
    let resolvedRef = cleanRef;
    if (!runner) {
      const checkLocal = exec("git", ["-C", targetDir, "rev-parse", "--verify", cleanRef], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
      });
      if ((checkLocal?.status ?? 1) !== 0) {
        const bareBranch = cleanRef.replace(/^refs\/heads\//, "").replace(new RegExp(`^${remote}/`), "");
        const fetchRes = exec("git", ["-C", targetDir, "fetch", remote, bareBranch], {
          shell: false,
          windowsHide: true,
          encoding: "utf8",
        });
        if ((fetchRes?.status ?? 1) !== 0) {
          throw new Error(`git fetch ${remote} ${bareBranch} failed: ${fetchRes?.stderr || fetchRes?.stdout}`);
        }
        resolvedRef = "FETCH_HEAD";
      }
    }

    const base = mission?.freezeCommit || "HEAD";
    const diffNamesRes = exec("git", ["-C", targetDir, "diff", "--name-only", `${base}..${resolvedRef}`], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if ((diffNamesRes?.status ?? 0) !== 0) {
      throw new Error(`git diff --name-only failed for ${resolvedRef}: ${diffNamesRes?.stderr || diffNamesRes?.stdout}`);
    }
    const touchedFiles = String(diffNamesRes?.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim().replaceAll("\\", "/"))
      .filter(Boolean);
    assertNoSharedContractMutation(touchedFiles, mission?.contracts || [], `cloud branch "${cleanRef}"`);

    const mergeRes = exec("git", ["-C", targetDir, "merge", "--no-ff", "--no-edit", resolvedRef], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    const mergeCode = mergeRes?.status ?? mergeRes?.exitCode ?? (mergeRes?.error ? 1 : 0);
    if (mergeRes?.error || mergeCode !== 0) {
      throw new Error(`git merge ${resolvedRef} failed in "${targetDir}": ${mergeRes?.error?.message || mergeRes?.stderr || mergeRes?.stdout}`);
    }

    if (store?.recordEvent && mission) {
      store.recordEvent(
        mission.id,
        "coordinator",
        "cloud_ingested",
        {
          laneId,
          mode: "branch",
          branchRef: cleanRef,
          touchedFiles,
          worktreePath: targetDir,
          status: lane?.status || "active",
        },
        {
          laneId,
          summary: `Ingested cloud branch ${cleanRef} into lane ${laneId} (${touchedFiles.length} file(s))`,
        },
      );
    }

    return {
      ok: true,
      mode: "branch",
      missionId: mission?.id || missionId,
      laneId,
      branchRef: cleanRef,
      touchedFiles,
      targetDir,
    };
  }

  throw new Error("ingestCloudArtifact requires either patchText/patchPath with expectedSha256, or branchRef.");
}

function invokeDevinBridge(toolName, payload, { bridgePath = defaultDevinVmBridge(), nodeExe = process.execPath, runner, timeoutMs = 120_000 } = {}) {
  if (!runner && (!bridgePath || !existsSync(bridgePath))) {
    throw new Error(
      bridgePath
        ? `Devin VM bridge not found at "${bridgePath}".`
        : "Devin VM bridge not configured (set OVERDRIVE_DEVIN_VM_BRIDGE or ~/.overdrive/config.json).",
    );
  }
  const exec = typeof runner === "function" ? runner : defaultRunner;
  const args = [bridgePath, "call", toolName, "--json", JSON.stringify(payload)];
  const res = exec(nodeExe, args, {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const exitCode = res?.status ?? res?.exitCode ?? (res?.error ? 1 : 0);
  if (res?.error || exitCode !== 0) {
    throw new Error(`Devin VM bridge ${toolName} failed: ${res?.error?.message || res?.stderr || res?.stdout || `exit ${exitCode}`}`);
  }
  const parsed = parseJsonSafe(res?.stdout);
  if (!parsed) {
    throw new Error(`Devin VM bridge ${toolName} returned non-JSON output: ${String(res?.stdout || "").slice(0, 300)}`);
  }
  return parsed;
}

/** Spawn an idle/sandbox Devin Cloud VM (0.0 ACU LLM burn) via the configured Devin VM bridge. */
export function spawnDevinSandbox({
  platform = "linux",
  repo = "",
  mode,
  bridgePath = defaultDevinVmBridge(),
  nodeExe = process.execPath,
  runner,
  timeoutMs = 120_000,
} = {}) {
  const payload = { platform };
  if (repo) payload.repo = repo;
  if (mode) payload.mode = mode;
  return invokeDevinBridge("vm_spawn", payload, { bridgePath, nodeExe, runner, timeoutMs });
}

/** Execute a shell command inside a Devin Cloud VM via the configured Devin VM bridge. */
export function execInDevinSandbox(sessionIdOrOpts, maybeCommand, maybeOpts = {}) {
  const opts = typeof sessionIdOrOpts === "object" && sessionIdOrOpts !== null ? sessionIdOrOpts : { ...maybeOpts, sessionId: sessionIdOrOpts, command: maybeCommand };
  const sessionId = opts.session_id || opts.sessionId;
  const command = opts.command;
  if (!sessionId || !command) {
    throw new Error("execInDevinSandbox requires sessionId and command.");
  }
  const payload = { session_id: sessionId, command };
  if (opts.cwd) payload.cwd = opts.cwd;
  if (opts.timeoutSec !== undefined) payload.timeout_sec = opts.timeoutSec;
  if (opts.timeout_sec !== undefined) payload.timeout_sec = opts.timeout_sec;
  if (opts.transport) payload.transport = opts.transport;
  if (opts.stdin !== undefined) payload.stdin = opts.stdin;
  return invokeDevinBridge("vm_exec", payload, {
    bridgePath: opts.bridgePath,
    nodeExe: opts.nodeExe,
    runner: opts.runner,
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
}

/** Archive (tear down) one or more Devin Cloud VMs via the configured Devin VM bridge. */
export function archiveDevinSandbox(sessionIdOrOpts, maybeOpts = {}) {
  let payload;
  let bridgeOpts = maybeOpts;
  if (Array.isArray(sessionIdOrOpts)) {
    payload = { session_ids: sessionIdOrOpts };
  } else if (typeof sessionIdOrOpts === "object" && sessionIdOrOpts !== null) {
    bridgeOpts = sessionIdOrOpts;
    if (Array.isArray(sessionIdOrOpts.session_ids || sessionIdOrOpts.sessionIds)) {
      payload = { session_ids: sessionIdOrOpts.session_ids || sessionIdOrOpts.sessionIds };
    } else {
      const sid = sessionIdOrOpts.session_id || sessionIdOrOpts.sessionId;
      if (!sid) throw new Error("archiveDevinSandbox requires sessionId or sessionIds.");
      payload = { session_id: sid };
    }
  } else {
    if (!sessionIdOrOpts) throw new Error("archiveDevinSandbox requires sessionId.");
    payload = { session_id: String(sessionIdOrOpts) };
  }
  return invokeDevinBridge("vm_archive", payload, {
    bridgePath: bridgeOpts.bridgePath,
    nodeExe: bridgeOpts.nodeExe,
    runner: bridgeOpts.runner,
    timeoutMs: bridgeOpts.timeoutMs ?? 60_000,
  });
}
