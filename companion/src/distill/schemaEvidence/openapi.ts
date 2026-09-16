import { relative } from "node:path";
import type { ApiCall } from "../../types.js";
import type { SchemaHint, SchemaProvider } from "./types.js";
import { globFiles } from "../../util/glob.js";
import { readJson } from "../../util/fs.js";

interface Doc { file: string; json: Record<string, unknown> }
interface Operation { doc: Doc; path: string; method: string; op: Record<string, unknown> }

/**
 * OpenAPI 3 / Swagger 2 evidence: required / minLength / maxLength / enum / format for request-body
 * properties. Paths are matched case-insensitively by suffix so "orders/OrderCreate" hits
 * "/Orders/OrderCreate" regardless of the servers.url prefix.
 */
export function createOpenApiProvider(projectDir: string, glob: string): SchemaProvider {
  const docs: Doc[] = [];
  for (const file of globFiles(projectDir, glob)) {
    try {
      const json = readJson<Record<string, unknown>>(file);
      if (json && typeof json === "object" && (json.paths || json.openapi || json.swagger)) docs.push({ file, json });
    } catch { /* skip unreadable */ }
  }
  const ops: Operation[] = [];
  for (const doc of docs) {
    const paths = (doc.json.paths ?? {}) as Record<string, Record<string, unknown>>;
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(item ?? {})) {
        if (["get", "post", "put", "patch", "delete", "head", "options"].includes(method) && op && typeof op === "object") {
          ops.push({ doc, path, method, op: op as Record<string, unknown> });
        }
      }
    }
  }

  const norm = (s: string) => s.replace(/^\/+|\/+$/g, "").toLowerCase();

  function findOperation(call: ApiCall): Operation | undefined {
    const want = norm(call.url.split("?")[0]);
    const m = call.method.toLowerCase();
    let best: Operation | undefined;
    for (const o of ops) {
      if (o.method !== m) continue;
      const p = norm(o.path);
      if (p === want || want.endsWith(`/${p}`) || p.endsWith(`/${want}`) || want.endsWith(p)) {
        if (!best || p.length > norm(best.path).length) best = o;
      }
    }
    return best;
  }

  function deref(doc: Doc, schema: unknown, depth = 0): Record<string, unknown> | undefined {
    if (!schema || typeof schema !== "object" || depth > 10) return undefined;
    const s = schema as Record<string, unknown>;
    if (typeof s.$ref === "string") {
      const ref = s.$ref;
      if (!ref.startsWith("#/")) return undefined;
      let cur: unknown = doc.json;
      for (const seg of ref.slice(2).split("/")) cur = (cur as Record<string, unknown> | undefined)?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
      return deref(doc, cur, depth + 1);
    }
    return s;
  }

  function requestBodySchema(o: Operation): { schema: Record<string, unknown>; where: string } | undefined {
    const rb = o.op.requestBody as Record<string, unknown> | undefined;
    if (rb) {
      const content = deref(o.doc, rb)?.content as Record<string, Record<string, unknown>> | undefined;
      if (content) {
        const media = content["application/json"] ?? Object.values(content)[0];
        const schema = deref(o.doc, media?.schema);
        if (schema) return { schema, where: `${o.path}#requestBody` };
      }
    }
    // Swagger 2: body parameter
    const params = (o.op.parameters as Record<string, unknown>[] | undefined) ?? [];
    const body = params.find((p) => p.in === "body");
    if (body) {
      const schema = deref(o.doc, body.schema);
      if (schema) return { schema, where: `${o.path}#parameters/body` };
    }
    return undefined;
  }

  return {
    kind: "openapi",
    size: docs.length,
    lookup(call, pointer): SchemaHint | null {
      const o = findOperation(call);
      if (!o) return null;
      const body = requestBodySchema(o);
      if (!body) return null;
      const segs = pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
      let schema: Record<string, unknown> | undefined = body.schema;
      let required = false;
      let name = "";
      for (const seg of segs) {
        if (!schema) return null;
        if (/^\d+$/.test(seg)) { schema = deref(o.doc, schema.items); continue; }
        const props = deref(o.doc, schema.properties) as Record<string, unknown> | undefined;
        const found = props ? Object.keys(props).find((k) => k.toLowerCase() === seg.toLowerCase()) : undefined;
        if (!found) return null;
        required = Array.isArray(schema.required) && (schema.required as string[]).some((r) => r.toLowerCase() === seg.toLowerCase());
        name = found;
        schema = deref(o.doc, (props as Record<string, unknown>)[found]);
      }
      if (!schema) return null;
      const hint: SchemaHint = {
        location: `${relative(projectDir, o.doc.file).replace(/\\/g, "/")}:${body.where}/${name}`,
        required,
        type: typeof schema.type === "string" ? schema.type : undefined,
        format: typeof schema.format === "string" ? schema.format : undefined,
        minLength: typeof schema.minLength === "number" ? schema.minLength : undefined,
        maxLength: typeof schema.maxLength === "number" ? schema.maxLength : undefined,
        enum: Array.isArray(schema.enum) ? schema.enum : undefined,
      };
      if (schema["x-unique"] === true || schema["x-uniqueness"] === true) hint.unique = true;
      return hint;
    },
  };
}
