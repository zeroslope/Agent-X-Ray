import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileExists } from "../fs.ts";
import type { ProductAdapter, ProductReportContext } from "./index.ts";

type SourceStatus = "active" | "inactive" | "error";

type ReportIssue = {
  code: string;
  message: string;
  source?: string;
};

type ConfigLayer = {
  capability: "config";
  kind: "user";
  path: string;
  status: SourceStatus;
  reason?: string;
  keySummary?: string[];
  sectionSummary?: string[];
  issues: ReportIssue[];
};

type CodexReport = {
  generatedAt: string;
  product: "codex";
  cwd: string;
  codexHome: {
    path: string;
    source: "env" | "default";
  };
  capabilities: {
    configLayers: ConfigLayer[];
  };
  issues: ReportIssue[];
};

export const codexAdapter: ProductAdapter = {
  name: "codex",
  async generateReport(context: ProductReportContext): Promise<CodexReport> {
    const codexHome = await discoverCodexHome(context.env, context.processCwd);
    const userConfigPath = join(codexHome.path, "config.toml");
    const userConfigLayer = await readUserConfigLayer(userConfigPath);

    return {
      generatedAt: new Date().toISOString(),
      product: "codex",
      cwd: context.cwd,
      codexHome,
      capabilities: {
        configLayers: [userConfigLayer],
      },
      issues: [],
    };
  },
};

async function discoverCodexHome(env: NodeJS.ProcessEnv, processCwd: string): Promise<CodexReport["codexHome"]> {
  const value = env.CODEX_HOME;
  if (value && value.length > 0) {
    return { path: await normalizePath(value, processCwd), source: "env" };
  }

  return { path: await normalizePath(join(homedir(), ".codex"), processCwd), source: "default" };
}

async function normalizePath(path: string, base: string): Promise<string> {
  const absolutePath = resolve(base, path);
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

async function readUserConfigLayer(path: string): Promise<ConfigLayer> {
  if (!(await fileExists(path))) {
    return {
      capability: "config",
      kind: "user",
      path,
      status: "inactive",
      reason: "not_found",
      issues: [],
    };
  }

  const text = await readFile(path, "utf8");
  try {
    const parsed = Bun.TOML.parse(text);
    return {
      capability: "config",
      kind: "user",
      path,
      status: "active",
      keySummary: summarizeTopLevelKeys(parsed),
      sectionSummary: summarizeTopLevelSections(parsed),
      issues: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      capability: "config",
      kind: "user",
      path,
      status: "error",
      issues: [
        {
          code: "toml_parse_error",
          message,
          source: path,
        },
      ],
    };
  }
}

function summarizeTopLevelKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([, child]) => !isRecord(child))
    .map(([key]) => key)
    .sort();
}

function summarizeTopLevelSections(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([, child]) => isRecord(child))
    .map(([key]) => key)
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
