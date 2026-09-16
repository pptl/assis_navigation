import type { ApiCall } from "../../types.js";

export interface SchemaHint {
  location: string;
  required?: boolean;
  unique?: boolean;
  minLength?: number;
  maxLength?: number;
  enum?: unknown[];
  format?: string;
  type?: string;
  note?: string;
}

export interface SchemaProvider {
  kind: "openapi" | "efcore";
  /** number of documents/files indexed — for diagnostics */
  size: number;
  /** paramPointer is a JSON pointer into the request body ("/filter/name"). */
  lookup(call: ApiCall, paramPointer: string): SchemaHint | null;
}
