#!/usr/bin/env bun
import { Command } from "commander";
import { resolveExistingDirectory } from "./fs.ts";
import { createProductAdapter } from "./products/index.ts";

type Writable = {
  write(chunk: string): unknown;
};

type CliRuntime = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: Writable;
  stderr: Writable;
};

type CliOptions = {
  product: string;
  cwd: string;
  pretty?: boolean;
};

export async function runCli(runtime: CliRuntime): Promise<number> {
  const parsed = parseOptions(runtime);
  if (!parsed.ok) {
    return parsed.exitCode;
  }

  const cwd = await resolveExistingDirectory(parsed.options.cwd);
  if (!cwd.ok) {
    runtime.stderr.write(`${cwd.error}\n`);
    return 1;
  }

  const adapter = createProductAdapter(parsed.options.product);
  if (!adapter.ok) {
    runtime.stderr.write(`${adapter.error}\n`);
    return 1;
  }

  const report = await adapter.product.generateReport({
    cwd: cwd.path,
    processCwd: runtime.cwd,
    env: runtime.env,
  });

  runtime.stdout.write(`${JSON.stringify(report, null, parsed.options.pretty ? 2 : undefined)}\n`);
  return 0;
}

function parseOptions(runtime: CliRuntime): { ok: true; options: CliOptions } | { ok: false; exitCode: number } {
  const program = new Command();
  program
    .name("axray")
    .description("Explain the agent context assembled by an agent product.")
    .allowExcessArguments(false)
    .allowUnknownOption(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => runtime.stdout.write(text),
      writeErr: (text) => runtime.stderr.write(text),
    })
    .option("--product <product>", "agent product to inspect", "codex")
    .option("--cwd <path>", "working directory to inspect", runtime.cwd)
    .option("--pretty", "pretty-print JSON output");

  try {
    program.parse(runtime.argv, { from: "user" });
    return { ok: true, options: program.opts<CliOptions>() };
  } catch (error) {
    return { ok: false, exitCode: typeof error === "object" && error !== null && "exitCode" in error ? Number(error.exitCode) : 1 };
  }
}

if (import.meta.main) {
  process.exitCode = await runCli({
    argv: Bun.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
