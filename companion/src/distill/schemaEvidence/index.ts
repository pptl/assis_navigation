import type { NavConfig } from "../../types.js";
import type { SchemaProvider } from "./types.js";
import { createOpenApiProvider } from "./openapi.js";
import { createEfCoreProvider } from "./efcore.js";

export function createProviders(cfg: NavConfig, projectDir: string): SchemaProvider[] {
  const out: SchemaProvider[] = [];
  for (const src of cfg.schemaSources) {
    if (src.kind === "openapi") out.push(createOpenApiProvider(projectDir, src.glob));
    else if (src.kind === "efcore") out.push(createEfCoreProvider(projectDir, src.glob));
  }
  return out;
}

export type { SchemaHint, SchemaProvider } from "./types.js";
