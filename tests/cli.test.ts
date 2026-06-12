import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = new URL("..", import.meta.url).pathname;

let tempRoots: string[] = [];

beforeEach(() => {
  tempRoots = [];
});

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function runAxray(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

test("emits compact Codex context report JSON for a fake home and cwd", async () => {
  const codexHome = await makeTempDir("axray-home-");
  const project = await makeTempDir("axray-project-");
  await mkdir(join(project, ".git"));
  await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5"\n');

  const result = await runAxray(["--cwd", project], { CODEX_HOME: codexHome });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.trim()).not.toContain("\n");

  const report = JSON.parse(result.stdout);
  const expectedCodexHome = await realpath(codexHome);
  const expectedProject = await realpath(project);
  expect(report.product).toBe("codex");
  expect(report.cwd).toBe(expectedProject);
  expect(report.codexHome).toEqual({ path: expectedCodexHome, source: "env" });
  expect(typeof report.generatedAt).toBe("string");
  expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(report).not.toHaveProperty("schemaVersion");
  expect(report).not.toHaveProperty("effective");
  expect(report).not.toHaveProperty("effectiveConfig");
});

test("normalizes reported Codex home and cwd to absolute paths", async () => {
  const codexHome = await makeTempDir("axray-home-");
  const project = await makeTempDir("axray-project-");
  await mkdir(join(project, ".git"));

  const relativeHome = relative(repoRoot, codexHome);
  const relativeProject = relative(repoRoot, project);
  const result = await runAxray(["--cwd", relativeProject], { CODEX_HOME: relativeHome });

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.cwd).toBe(await realpath(project));
  expect(report.codexHome).toEqual({ path: await realpath(codexHome), source: "env" });
});

test("selects Codex explicitly and emits pretty JSON when requested", async () => {
  const codexHome = await makeTempDir("axray-home-");
  const project = await makeTempDir("axray-project-");

  const result = await runAxray(["--product", "codex", "--cwd", project, "--pretty"], {
    CODEX_HOME: codexHome,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain('\n  "product": "codex"');
  expect(JSON.parse(result.stdout).product).toBe("codex");
});

test("fails at command level for unsupported products", async () => {
  const result = await runAxray(["--product", "claude"]);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Unsupported product: claude");
});

test("fails at command level for inaccessible working directories", async () => {
  const codexHome = await makeTempDir("axray-home-");
  const missingProject = join(await makeTempDir("axray-project-parent-"), "missing");

  const result = await runAxray(["--cwd", missingProject], { CODEX_HOME: codexHome });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`Cannot access working directory: ${missingProject}`);
});

test("keeps broken source files inside a partial report", async () => {
  const codexHome = await makeTempDir("axray-home-");
  const project = await makeTempDir("axray-project-");
  await writeFile(join(codexHome, "config.toml"), "model = \n");

  const result = await runAxray(["--cwd", project], { CODEX_HOME: codexHome });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");

  const report = JSON.parse(result.stdout);
  expect(report.capabilities.configLayers).toEqual([
    expect.objectContaining({
      kind: "user",
      status: "error",
      issues: [
        expect.objectContaining({
          code: "toml_parse_error",
        }),
      ],
    }),
  ]);
});
