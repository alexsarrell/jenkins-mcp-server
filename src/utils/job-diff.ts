import type { JobDescription } from "./job-xml.js";

export interface FieldChange {
  path: string;
  before: string;
  after: string;
}

function flatten(obj: unknown, prefix: string): Record<string, string> {
  if (obj === null || obj === undefined) return { [prefix]: "(unset)" };
  if (typeof obj !== "object") return { [prefix]: String(obj) };
  if (Array.isArray(obj)) return { [prefix]: JSON.stringify(obj) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    Object.assign(out, flatten(v, next));
  }
  return out;
}

export function diffJobSpecs(before: JobDescription, after: JobDescription): FieldChange[] {
  const a = flatten(before, "");
  const b = flatten(after, "");
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changes: FieldChange[] = [];
  for (const k of keys) {
    if (k === "rawConfigSha" || k.startsWith("unknownXmlElements")) continue;
    const left = a[k] ?? "(unset)";
    const right = b[k] ?? "(unset)";
    if (left !== right) changes.push({ path: k, before: left, after: right });
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}
