import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root directory for Overdrive configuration and portable state (~/.overdrive). */
export function overdriveHome() {
  return path.resolve(process.env.OVERDRIVE_HOME || path.join(os.homedir(), ".overdrive"));
}

/**
 * Load optional per-user machine overrides from `~/.overdrive/config.json` (or `OVERDRIVE_CONFIG`).
 * Skipped when `OVERDRIVE_IGNORE_USER_CONFIG=1` (used in portable CI tests).
 */
export function loadUserConfig() {
  if (process.env.OVERDRIVE_IGNORE_USER_CONFIG === "1") return {};
  const cfgPath = process.env.OVERDRIVE_CONFIG
    ? path.resolve(process.env.OVERDRIVE_CONFIG)
    : path.join(overdriveHome(), "config.json");
  if (!existsSync(cfgPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function defaultDataDir() {
  const envDir = process.env.OVERDRIVE_DATA || process.env.OVERDRIVE_DATA_DIR;
  if (envDir) return path.resolve(envDir);
  const cfg = loadUserConfig();
  if (cfg.dataDir) return path.resolve(cfg.dataDir);
  return path.join(overdriveHome(), "data");
}

export function defaultWorktreeRoot() {
  if (process.env.OVERDRIVE_WT_ROOT) return process.env.OVERDRIVE_WT_ROOT;
  const cfg = loadUserConfig();
  return cfg.worktreeRoot || path.join(overdriveHome(), "worktrees");
}

export function defaultScratchBase() {
  if (process.env.OVERDRIVE_SCRATCH_DIR_BASE) return path.resolve(process.env.OVERDRIVE_SCRATCH_DIR_BASE);
  const cfg = loadUserConfig();
  if (cfg.scratchDir) return path.resolve(cfg.scratchDir);
  return path.join(os.tmpdir(), "overdrive");
}

export function defaultTestScratchBase() {
  if (process.env.OVERDRIVE_TEST_SCRATCH) return path.resolve(process.env.OVERDRIVE_TEST_SCRATCH);
  return path.join(defaultScratchBase(), "tests");
}

export function defaultLockDir() {
  if (process.env.OVERDRIVE_LOCK_DIR) return path.resolve(process.env.OVERDRIVE_LOCK_DIR);
  const cfg = loadUserConfig();
  if (cfg.lockDir) return path.resolve(cfg.lockDir);
  return path.join(defaultScratchBase(), "locks");
}

export function defaultPrivateDir() {
  if (process.env.OVERDRIVE_PRIVATE_DIR) return path.resolve(process.env.OVERDRIVE_PRIVATE_DIR);
  const cfg = loadUserConfig();
  if (cfg.privateDir) return path.resolve(cfg.privateDir);
  return path.join(overdriveHome(), "private");
}

export function defaultCloudLedgerDir() {
  const envDir = process.env.OVERDRIVE_CLOUD_LEDGER_DIR || process.env.OVERDRIVE_CLOUD_LEDGER;
  if (envDir) return path.resolve(envDir);
  const cfg = loadUserConfig();
  if (cfg.cloudLedgerDir) return path.resolve(cfg.cloudLedgerDir);
  return path.join(overdriveHome(), "cloud-ledger");
}

export function defaultAdhdDataDir() {
  const envDir = process.env.OVERDRIVE_ADHD_DATA || process.env.GOAL_LOOP_DATA;
  if (envDir) return envDir;
  const cfg = loadUserConfig();
  return cfg.adhdDataDir || path.join(os.homedir(), ".adhd", "data");
}

export function defaultAipcScript() {
  if (process.env.OVERDRIVE_AIPC_SCRIPT) return process.env.OVERDRIVE_AIPC_SCRIPT;
  const cfg = loadUserConfig();
  return cfg.aipcScript || null;
}

export function defaultDevinVmBridge() {
  if (process.env.OVERDRIVE_DEVIN_VM_BRIDGE) return process.env.OVERDRIVE_DEVIN_VM_BRIDGE;
  const cfg = loadUserConfig();
  return cfg.devinVmBridge || null;
}

export function defaultConnectAnythingBin() {
  if (process.env.OVERDRIVE_CONNECT_ANYTHING) return process.env.OVERDRIVE_CONNECT_ANYTHING;
  const cfg = loadUserConfig();
  return cfg.connectAnythingBin || null;
}

export function defaultAccountPoolPath() {
  if (process.env.OVERDRIVE_ACCOUNT_POOL) return process.env.OVERDRIVE_ACCOUNT_POOL;
  const cfg = loadUserConfig();
  return cfg.accountPoolPath || path.join(overdriveHome(), "account_pool.json");
}

export function defaultTeamCliPath() {
  if (process.env.OVERDRIVE_TEAM_CLI) return process.env.OVERDRIVE_TEAM_CLI;
  const cfg = loadUserConfig();
  return cfg.teamCliPath || null;
}

export function defaultAssistantMcpServer() {
  if (process.env.OVERDRIVE_ASSISTANT_MCP) return process.env.OVERDRIVE_ASSISTANT_MCP;
  const cfg = loadUserConfig();
  return cfg.assistantMcpServer || "assistant-hq";
}

export function defaultLedgerPath() {
  if (process.env.OVERDRIVE_LEDGER_PATH) return process.env.OVERDRIVE_LEDGER_PATH;
  const cfg = loadUserConfig();
  return cfg.ledgerPath || path.join(overdriveHome(), "rsi", "ledger.sqlite");
}

export function defaultMemoryPath() {
  if (process.env.OVERDRIVE_MEMORY_PATH) return process.env.OVERDRIVE_MEMORY_PATH;
  const cfg = loadUserConfig();
  return cfg.memoryPath || path.join(overdriveHome(), "rsi", "memory.db");
}

export function defaultDriftPath() {
  if (process.env.OVERDRIVE_DRIFT_PATH) return process.env.OVERDRIVE_DRIFT_PATH;
  const cfg = loadUserConfig();
  return cfg.driftPath || path.join(overdriveHome(), "rsi", "drift.json");
}

export function defaultArpdDir() {
  if (process.env.OVERDRIVE_ARPD_DIR) return process.env.OVERDRIVE_ARPD_DIR;
  const cfg = loadUserConfig();
  return cfg.arpdDir || path.join(overdriveHome(), "rsi", "research");
}

export function defaultExternalRepoHints() {
  const cfg = loadUserConfig();
  return Array.isArray(cfg.externalRepoHints) ? cfg.externalRepoHints.map(String).filter(Boolean) : [];
}
