import { codexAdapter } from "./codex.ts";

export type ProductReportContext = {
  cwd: string;
  processCwd: string;
  env: NodeJS.ProcessEnv;
};

export type ProductAdapter = {
  name: string;
  generateReport(context: ProductReportContext): Promise<unknown>;
};

export function createProductAdapter(product: string): { ok: true; product: ProductAdapter } | { ok: false; error: string } {
  if (product === codexAdapter.name) {
    return { ok: true, product: codexAdapter };
  }

  return { ok: false, error: `Unsupported product: ${product}` };
}
