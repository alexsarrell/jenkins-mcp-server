# Jenkins MCP v1.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship eight backward-compatible features for `@alexsarrell/jenkins-mcp-server` (multi-value `triggerBuild` fix, `getBuild` parameters, `getQueueItem`, `getJobParameters`, `describeJob`, `previewJobConfig`, in-tool log grep, `searchBuildLogs` v2 with progressive read).

**Architecture:** New shared schema `ParameterSpec` (Zod discriminated union). New shared parser/builder for Jenkins `config.xml` (`fast-xml-parser`-based, partial-coverage). Vitest for unit-testing pure functions; manual verification for tool wiring.

**Tech Stack:** TypeScript 5.9 (strict, Node16 ESM), Zod 4, MCP SDK 1.27, Vitest (new), fast-xml-parser ^4 (new). Existing: ESLint 9.28, GitLab CI auto-release.

**Spec:** [docs/superpowers/specs/2026-04-29-jenkins-mcp-v2-design.md](../specs/2026-04-29-jenkins-mcp-v2-design.md)

---

## File Structure

**New files**
- `src/schemas/parameter.ts` — canonical `ParameterSpec` discriminated union
- `src/utils/parameter-mapper.ts` — Jenkins API JSON → `ParameterSpec`
- `src/utils/job-xml.ts` — `config.xml` parser + builder (shared by `describeJob` and `previewJobConfig`)
- `src/utils/job-diff.ts` — structured spec-vs-spec diff
- `src/utils/log-grep.ts` — pure substring/regex grep with context (shared by `getBuildLog` and `searchBuildLogs`)
- `vitest.config.ts` — test runner configuration
- `tests/schemas/parameter.test.ts`
- `tests/utils/parameter-mapper.test.ts`
- `tests/utils/log-grep.test.ts`
- `tests/utils/job-xml.test.ts`
- `tests/utils/job-diff.test.ts`
- `tests/utils/formatters.test.ts`
- `tests/fixtures/pipeline-config.xml`
- `tests/fixtures/multibranch-config.xml`
- `tests/fixtures/freestyle-config.xml`

**Modified files**
- `src/tools/builds.ts` — `triggerBuild` multi-value fix, `getBuild` parameters/include, `getBuildLog` grep mode
- `src/tools/jobs.ts` — register `getJobParameters`, `describeJob`, `previewJobConfig`
- `src/tools/discovery.ts` — register `getQueueItem`, `searchBuildLogs` v2
- `src/jenkins-client.ts` — add `getProgressiveText` helper
- `src/utils/formatters.ts` — extend `formatBuild` with parameters; add `formatQueueItem`; add masking for password parameters
- `src/types.ts` — add `JenkinsParameterValue`, `QueueItemState` types
- `package.json` — add `fast-xml-parser`, `vitest`, `@vitest/coverage-v8`; bump to `1.2.0`; add `test`/`test:watch` scripts
- `README.md` — document new tools and multi-value migration note
- `.gitlab-ci.yml` — add `test` job in `check` stage

**Layout rationale.** All XML logic lives in one helper (`job-xml.ts`) so the parser used to read existing config (Task 8) and the builder used to emit a new config (Task 9) share a structured-shape contract. Grep logic is extracted to `log-grep.ts` so the single-build (Task 6) and multi-build (Task 7) consumers are pure-function-testable. Tests live in a top-level `tests/` directory mirroring `src/` to keep production source clean.

---

## Task 1: Set up Vitest and add a smoke test

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/smoke.test.ts`
- Modify: `package.json`
- Modify: `.gitlab-ci.yml`

- [ ] **Step 1: Install Vitest**

```bash
npm install --save-dev vitest@^3.0.0 @vitest/coverage-v8@^3.0.0
```

Expected: deps added, `package.json` and `package-lock.json` updated. Pin Vitest to a single major (`^3`) so future installs stay deterministic.

- [ ] **Step 2: Add `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
```

- [ ] **Step 3: Add npm scripts**

In `package.json` `"scripts"` block, add (preserving existing keys):

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write smoke test**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("vitest is wired up", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the smoke test**

Run: `npm test`

Expected: 1 passed, 0 failed. Build does not run TypeScript compilation (Vitest uses esbuild internally) — that's OK.

- [ ] **Step 6: Wire CI**

In `.gitlab-ci.yml`, add a new `test` job in the `check` stage (peers with `lint` and `build`):

```yaml
test:
  stage: check
  script:
    - npm test
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/smoke.test.ts .gitlab-ci.yml
git commit -m "chore: add Vitest test runner"
```

---

## Task 2: `ParameterSpec` schema (foundation)

**Files:**
- Create: `src/schemas/parameter.ts`
- Create: `tests/schemas/parameter.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/schemas/parameter.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parameterSpec } from "../../src/schemas/parameter.js";

describe("parameterSpec", () => {
  it("accepts a string parameter", () => {
    const out = parameterSpec.parse({ type: "string", name: "FOO", default: "bar" });
    expect(out).toMatchObject({ type: "string", name: "FOO", default: "bar" });
  });

  it("accepts a choice parameter with choices", () => {
    const out = parameterSpec.parse({
      type: "choice",
      name: "ENV",
      choices: ["dev", "stage", "prod"],
    });
    expect(out.type === "choice" && out.choices).toEqual(["dev", "stage", "prod"]);
  });

  it("accepts a boolean parameter", () => {
    expect(() => parameterSpec.parse({ type: "boolean", name: "DRY_RUN", default: true })).not.toThrow();
  });

  it("accepts password without default exposure", () => {
    expect(() => parameterSpec.parse({ type: "password", name: "TOKEN" })).not.toThrow();
  });

  it("accepts unknown branch with rawType", () => {
    const out = parameterSpec.parse({ type: "unknown", name: "X", rawType: "ExtendedChoiceParameterDefinition" });
    expect(out).toMatchObject({ type: "unknown", rawType: "ExtendedChoiceParameterDefinition" });
  });

  it("rejects choice without choices", () => {
    expect(() => parameterSpec.parse({ type: "choice", name: "ENV" })).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- tests/schemas/parameter.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement schema**

`src/schemas/parameter.ts`:
```ts
import { z } from "zod";

export const parameterSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("string"),
    name: z.string(),
    default: z.string().optional(),
    description: z.string().optional(),
    trim: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("text"),
    name: z.string(),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    name: z.string(),
    default: z.boolean().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("choice"),
    name: z.string(),
    choices: z.array(z.string()).min(1),
    default: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("password"),
    name: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("file"),
    name: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("run"),
    name: z.string(),
    projectName: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("credentials"),
    name: z.string(),
    credentialType: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("unknown"),
    name: z.string(),
    rawType: z.string(),
    description: z.string().optional(),
  }),
]);

export type ParameterSpec = z.infer<typeof parameterSpec>;
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- tests/schemas/parameter.test.ts`

Expected: 6 passed.

- [ ] **Step 5: Run full lint+build**

Run: `npm run lint && npm run build`

Expected: zero warnings, zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/parameter.ts tests/schemas/parameter.test.ts
git commit -m "feat: add ParameterSpec discriminated union schema"
```

---

## Task 3: Fix multi-value loss in `triggerBuild`

**Files:**
- Modify: `src/tools/builds.ts`
- Create: `src/utils/build-payload.ts`
- Create: `tests/utils/build-payload.test.ts`

**Background.** The current handler at `src/tools/builds.ts:24-45` does `value.split(",")` for any string value containing a comma. We extract the payload-building logic into a pure function so it's testable, then change its semantics: arrays are multi-value, strings are single-value (no implicit split), and a `splitOnComma: true` opt-in preserves the old behaviour for callers who depended on it.

- [ ] **Step 1: Write failing tests**

`tests/utils/build-payload.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildTriggerPayload } from "../../src/utils/build-payload.js";

describe("buildTriggerPayload", () => {
  it("submits a string value as a single field", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ FOO: "bar" }, false);
    expect(formData.getAll("FOO")).toEqual(["bar"]);
    expect(jsonParameters).toEqual([{ name: "FOO", value: "bar" }]);
  });

  it("does NOT split commas in a string value by default", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ DESC: "hello, world" }, false);
    expect(formData.getAll("DESC")).toEqual(["hello, world"]);
    expect(jsonParameters).toEqual([{ name: "DESC", value: "hello, world" }]);
  });

  it("submits a string array as multiple fields", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ TAGS: ["a", "b", "c"] }, false);
    expect(formData.getAll("TAGS")).toEqual(["a", "b", "c"]);
    expect(jsonParameters).toEqual([{ name: "TAGS", value: ["a", "b", "c"] }]);
  });

  it("legacy splitOnComma=true splits a comma-bearing string", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ TAGS: "a,b,c" }, true);
    expect(formData.getAll("TAGS")).toEqual(["a", "b", "c"]);
    expect(jsonParameters).toEqual([{ name: "TAGS", value: ["a", "b", "c"] }]);
  });

  it("legacy splitOnComma=true does not split a string without comma", () => {
    const { formData, jsonParameters } = buildTriggerPayload({ FOO: "bar" }, true);
    expect(formData.getAll("FOO")).toEqual(["bar"]);
    expect(jsonParameters).toEqual([{ name: "FOO", value: "bar" }]);
  });

  it("returns empty payload for no parameters", () => {
    const { formData, jsonParameters } = buildTriggerPayload({}, false);
    expect([...formData.entries()]).toEqual([]);
    expect(jsonParameters).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- tests/utils/build-payload.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement helper**

`src/utils/build-payload.ts`:
```ts
export interface JsonParameter {
  name: string;
  value: string | string[];
}

export interface TriggerPayload {
  formData: URLSearchParams;
  jsonParameters: JsonParameter[];
}

export type ParameterValue = string | string[];

export function buildTriggerPayload(
  parameters: Record<string, ParameterValue>,
  splitOnComma: boolean,
): TriggerPayload {
  const formData = new URLSearchParams();
  const jsonParameters: JsonParameter[] = [];

  for (const [name, raw] of Object.entries(parameters)) {
    const values: string[] = Array.isArray(raw)
      ? raw
      : splitOnComma && raw.includes(",")
      ? raw.split(",").map((v) => v.trim())
      : [raw];

    for (const v of values) {
      formData.append(name, v);
    }
    jsonParameters.push({
      name,
      value: values.length === 1 ? values[0] : values,
    });
  }

  return { formData, jsonParameters };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- tests/utils/build-payload.test.ts`

Expected: 6 passed.

- [ ] **Step 5: Update `triggerBuild` to use the helper**

In `src/tools/builds.ts`, replace the schema and the parameter-handling block in the handler.

Replace the existing schema (currently `parameters: z.record(z.string(), z.string()).optional()`) with:
```ts
parameters: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
  .describe("Build parameters. String values are submitted as-is (no comma splitting). Use string[] for multi-value parameters (ExtendedChoiceParameter, multi-select)."),
splitOnComma: z.boolean().optional().default(false)
  .describe("[DEPRECATED] Legacy behaviour: split comma-bearing string values into multi-value submissions. Will be removed in v2.0. Prefer string[] values instead."),
```

Replace the body of the handler (the `if (parameters && Object.keys(parameters).length > 0) { ... }` block at `builds.ts:24-45`) with:
```ts
const splitOnComma = (args.splitOnComma as boolean) ?? false;

if (parameters && Object.keys(parameters).length > 0) {
  const { formData, jsonParameters } = buildTriggerPayload(parameters, splitOnComma);
  void jsonParameters;
  result = await client.postForm(jobPath, "/buildWithParameters", formData);
} else {
  result = await client.post(jobPath, "/build");
}
```

(The `void jsonParameters` line is intentional — the JSON payload variant is reserved for the FILE/CREDENTIALS extension in v1.3 and isn't sent today. Keep the helper computing it so the v1.3 change is a one-line wire-up, not a refactor.)

Also at the top of `src/tools/builds.ts`, add:
```ts
import { buildTriggerPayload, type ParameterValue } from "../utils/build-payload.js";
```

And update the type assertion:
```ts
const parameters = args.parameters as Record<string, ParameterValue> | undefined;
```

- [ ] **Step 6: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero errors.

- [ ] **Step 7: Manual verification against a real Jenkins**

If a real Jenkins is reachable, run a parameterised build with a value containing a comma and confirm Jenkins receives the value intact (one parameter, one string with comma). Do the same with a `string[]` value and confirm multi-value submission. Record the result in the commit message body.

- [ ] **Step 8: Commit**

```bash
git add src/utils/build-payload.ts tests/utils/build-payload.test.ts src/tools/builds.ts
git commit -m "fix: triggerBuild no longer splits comma values by default

- string[] values are submitted as multi-value (no implicit split)
- string values are submitted intact (commas preserved)
- legacy splitOnComma: true opt-in preserves old behaviour, deprecated
- payload-building extracted to buildTriggerPayload for unit testing

Closes the silent-data-loss bug where 'foo, bar' was split into ['foo', 'bar']."
```

---

## Task 4: `getBuild` returns build parameters

**Files:**
- Modify: `src/tools/builds.ts`
- Modify: `src/utils/formatters.ts`
- Modify: `src/types.ts`
- Create: `tests/utils/formatters.test.ts` (or extend if it exists)

- [ ] **Step 1: Extend `JenkinsBuild` type**

In `src/types.ts`, replace the `actions` field of `JenkinsBuild`:
```ts
actions?: Array<{
  _class: string;
  causes?: Array<{ shortDescription: string; userName?: string }>;
  parameters?: Array<{ _class?: string; name: string; value?: string | boolean | number }>;
}>;
```

- [ ] **Step 2: Write failing tests for `formatBuild` parameters**

`tests/utils/formatters.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { formatBuild } from "../../src/utils/formatters.js";
import type { JenkinsBuild } from "../../src/types.js";

const buildBase: JenkinsBuild = {
  _class: "x",
  number: 42,
  url: "https://jenkins.example.com/job/x/42/",
  result: "SUCCESS",
  building: false,
  duration: 1000,
  estimatedDuration: 1000,
  timestamp: 1700000000000,
  displayName: "#42",
  fullDisplayName: "x #42",
  description: null,
};

describe("formatBuild parameters", () => {
  it("renders a parameters block when present", () => {
    const text = formatBuild({
      ...buildBase,
      actions: [
        {
          _class: "hudson.model.ParametersAction",
          parameters: [
            { _class: "hudson.model.StringParameterValue", name: "BRANCH", value: "main" },
            { _class: "hudson.model.BooleanParameterValue", name: "DRY_RUN", value: true },
          ],
        },
      ],
    });
    expect(text).toContain("Parameters:");
    expect(text).toContain("BRANCH = main");
    expect(text).toContain("DRY_RUN = true");
  });

  it("masks password parameter values", () => {
    const text = formatBuild({
      ...buildBase,
      actions: [
        {
          _class: "hudson.model.ParametersAction",
          parameters: [
            { _class: "hudson.model.PasswordParameterValue", name: "TOKEN", value: "" },
          ],
        },
      ],
    });
    expect(text).toContain("TOKEN = [hidden]");
    expect(text).not.toContain('""');
  });

  it("omits the parameters block when no parameters present", () => {
    const text = formatBuild({ ...buildBase, actions: [{ _class: "x", causes: [{ shortDescription: "Started by user" }] }] });
    expect(text).not.toContain("Parameters:");
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `npm test -- tests/utils/formatters.test.ts`

Expected: FAIL — `formatBuild` does not output a Parameters block.

- [ ] **Step 4: Update `formatBuild`**

In `src/utils/formatters.ts`, after the `// Artifacts` block (around line 128) and before the `// Changes` block, add:
```ts
// Parameters
const parametersAction = build.actions?.find((a) => a.parameters && a.parameters.length > 0);
if (parametersAction?.parameters) {
  lines.push(`\nParameters (${parametersAction.parameters.length}):`);
  for (const p of parametersAction.parameters) {
    const isPassword = (p._class || "").toLowerCase().includes("password");
    const display = isPassword ? "[hidden]" : String(p.value ?? "");
    lines.push(`  ${p.name} = ${display}`);
  }
}
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test -- tests/utils/formatters.test.ts`

Expected: 3 passed.

- [ ] **Step 6: Update `getBuild` tree query and add `include` parameter**

In `src/tools/builds.ts`, replace the `getBuild` registration block (currently at lines 62-83) with:

```ts
register(
  "getBuild",
  "Get detailed information about a specific build including status, duration, trigger cause, parameters, artifacts, and changes. Defaults to the last build if no number specified. Use 'include' to control which optional sections are returned.",
  z.object({
    jobPath: z.string().describe("Full job path"),
    buildNumber: z.number().optional().describe("Build number (default: last build)"),
    include: z.array(z.enum(["artifacts", "changes", "causes", "parameters"])).optional()
      .describe("Sections to include. Default: [\"causes\", \"parameters\", \"artifacts\", \"changes\"]"),
  }),
  async (args) => {
    const jobPath = args.jobPath as string;
    const buildNumber = args.buildNumber as number | undefined;
    const include = (args.include as string[] | undefined) ?? ["causes", "parameters", "artifacts", "changes"];
    const num = buildNumber ?? "lastBuild";

    try {
      const treeFields = [
        "number,url,result,building,duration,estimatedDuration,timestamp,displayName,description,fullDisplayName",
      ];
      const actionFields: string[] = [];
      if (include.includes("causes")) actionFields.push("causes[shortDescription,userName]");
      if (include.includes("parameters")) actionFields.push("parameters[name,value,_class]");
      if (actionFields.length > 0) treeFields.push(`actions[${actionFields.join(",")}]`);
      if (include.includes("artifacts")) treeFields.push("artifacts[displayPath,fileName,relativePath]");
      if (include.includes("changes")) treeFields.push("changeSets[items[msg,author[fullName],commitId]]");

      const data = await client.get(jobPath, `/${num}/api/json`, { tree: treeFields.join(",") });
      return ok(formatBuild(data as JenkinsBuild));
    } catch (e) {
      return handleError(e);
    }
  },
);
```

- [ ] **Step 7: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/utils/formatters.ts src/tools/builds.ts tests/utils/formatters.test.ts
git commit -m "feat: getBuild returns build parameters and supports include filter

- adds 'parameters' field to actions in tree query
- formatBuild renders a Parameters block, masks password values
- new optional 'include' parameter selects which sections to fetch"
```

---

## Task 5: `getQueueItem(queueId)` — bridge queue→build

**Files:**
- Modify: `src/tools/discovery.ts`
- Modify: `src/utils/formatters.ts`
- Modify: `src/types.ts`
- Modify: `tests/utils/formatters.test.ts`

- [ ] **Step 1: Add types**

In `src/types.ts`, append:
```ts
export interface QueueItemDetail {
  id: number;
  task: { name: string; url: string };
  why: string | null;
  cancelled?: boolean;
  executable?: { number: number; url: string };
  // _class distinguishes WaitingItem | BlockedItem | BuildableItem | LeftItem | CancelledItem
  _class?: string;
}

export type QueueItemState = "WAITING" | "BLOCKED" | "BUILDABLE" | "LEFT_QUEUE" | "CANCELLED" | "UNKNOWN";
```

- [ ] **Step 2: Write failing tests for `formatQueueItem`**

In `tests/utils/formatters.test.ts`, append:
```ts
import { formatQueueItem } from "../../src/utils/formatters.js";

describe("formatQueueItem", () => {
  it("renders WAITING with reason", () => {
    const out = formatQueueItem({
      id: 7,
      task: { name: "deploy", url: "https://j/job/deploy/" },
      why: "Waiting for next available executor",
      _class: "hudson.model.Queue$WaitingItem",
    });
    expect(out).toContain("Queue item #7: WAITING");
    expect(out).toContain("Why: Waiting for next available executor");
  });

  it("renders LEFT_QUEUE with executable build info", () => {
    const out = formatQueueItem({
      id: 7,
      task: { name: "deploy", url: "https://j/job/deploy/" },
      why: null,
      _class: "hudson.model.Queue$LeftItem",
      executable: { number: 42, url: "https://j/job/deploy/42/" },
    });
    expect(out).toContain("Queue item #7: LEFT_QUEUE");
    expect(out).toContain("Build started: deploy #42");
    expect(out).toContain("https://j/job/deploy/42/");
  });

  it("renders CANCELLED", () => {
    const out = formatQueueItem({
      id: 7,
      task: { name: "deploy", url: "https://j/job/deploy/" },
      why: null,
      cancelled: true,
      _class: "hudson.model.Queue$CancelledItem",
    });
    expect(out).toContain("Queue item #7: CANCELLED");
  });

  it("falls back to UNKNOWN for unrecognised _class", () => {
    const out = formatQueueItem({
      id: 7,
      task: { name: "deploy", url: "https://j/job/deploy/" },
      why: null,
      _class: "hudson.model.Queue$WeirdItem",
    });
    expect(out).toContain("Queue item #7: UNKNOWN");
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `npm test -- tests/utils/formatters.test.ts`

Expected: FAIL — `formatQueueItem` not exported.

- [ ] **Step 4: Implement `formatQueueItem`**

In `src/utils/formatters.ts`, append:
```ts
import type { QueueItemDetail, QueueItemState } from "../types.js";

function classifyQueueItem(item: QueueItemDetail): QueueItemState {
  if (item.cancelled) return "CANCELLED";
  const cls = item._class || "";
  if (cls.endsWith("$WaitingItem")) return "WAITING";
  if (cls.endsWith("$BlockedItem")) return "BLOCKED";
  if (cls.endsWith("$BuildableItem")) return "BUILDABLE";
  if (cls.endsWith("$LeftItem")) return "LEFT_QUEUE";
  if (cls.endsWith("$CancelledItem")) return "CANCELLED";
  return "UNKNOWN";
}

export function formatQueueItem(item: QueueItemDetail): string {
  const state = classifyQueueItem(item);
  const lines = [`Queue item #${item.id}: ${state}`];
  lines.push(`Task: ${item.task.name}`);
  if (state === "LEFT_QUEUE" && item.executable) {
    lines.push(`Build started: ${item.task.name} #${item.executable.number}`);
    lines.push(`URL: ${item.executable.url}`);
  } else if (item.why) {
    lines.push(`Why: ${item.why}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 5: Run, expect PASS**

Run: `npm test -- tests/utils/formatters.test.ts`

Expected: 4 new passes (plus the 3 from Task 4).

- [ ] **Step 6: Register the tool**

In `src/tools/discovery.ts`, after the `getQueue` registration (around line 85), add:

```ts
// 19. getQueueItem
register(
  "getQueueItem",
  "Get the state of a specific queue item by ID. Use the queue ID returned from triggerBuild ('Queue item: #N') to find which build was started — this bridges queue → build.",
  z.object({
    queueId: z.number().int().describe("Queue item ID"),
  }),
  async (args) => {
    const queueId = args.queueId as number;
    try {
      const data = await client.getAbsolute(`/queue/item/${queueId}/api/json`);
      return ok(formatQueueItem(data as QueueItemDetail));
    } catch (e) {
      return handleError(e);
    }
  },
);
```

At the top of `src/tools/discovery.ts`, add to imports:
```ts
import type { QueueItemDetail } from "../types.js";
import { formatQueueItem } from "../utils/formatters.js";
```

(The existing `formatQueue` import line stays.)

- [ ] **Step 7: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/utils/formatters.ts src/tools/discovery.ts tests/utils/formatters.test.ts
git commit -m "feat: add getQueueItem tool to bridge queue → build"
```

---

## Task 6: `getJobParameters` — structured parameter schema

**Files:**
- Create: `src/utils/parameter-mapper.ts`
- Create: `tests/utils/parameter-mapper.test.ts`
- Modify: `src/tools/jobs.ts`

- [ ] **Step 1: Write failing tests**

`tests/utils/parameter-mapper.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mapJenkinsParameter } from "../../src/utils/parameter-mapper.js";

describe("mapJenkinsParameter", () => {
  it("maps StringParameterDefinition to type:string", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.StringParameterDefinition",
        name: "BRANCH",
        description: "Git branch",
        defaultParameterValue: { value: "main" },
      }),
    ).toEqual({ type: "string", name: "BRANCH", description: "Git branch", default: "main" });
  });

  it("maps ChoiceParameterDefinition with choices", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.ChoiceParameterDefinition",
        name: "ENV",
        description: "",
        choices: ["dev", "stage", "prod"],
        defaultParameterValue: { value: "dev" },
      }),
    ).toEqual({ type: "choice", name: "ENV", choices: ["dev", "stage", "prod"], default: "dev" });
  });

  it("maps BooleanParameterDefinition with boolean default", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.BooleanParameterDefinition",
        name: "DRY_RUN",
        description: "",
        defaultParameterValue: { value: true },
      }),
    ).toEqual({ type: "boolean", name: "DRY_RUN", default: true });
  });

  it("maps PasswordParameterDefinition without exposing default", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.PasswordParameterDefinition",
        name: "TOKEN",
        description: "API token",
        defaultParameterValue: { value: "" },
      }),
    ).toEqual({ type: "password", name: "TOKEN", description: "API token" });
  });

  it("maps FileParameterDefinition", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.FileParameterDefinition",
        name: "PATCH",
        description: "",
      }),
    ).toEqual({ type: "file", name: "PATCH" });
  });

  it("maps RunParameterDefinition", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.RunParameterDefinition",
        name: "UPSTREAM",
        description: "",
        projectName: "upstream-job",
      }),
    ).toEqual({ type: "run", name: "UPSTREAM", projectName: "upstream-job" });
  });

  it("maps CredentialsParameterDefinition", () => {
    expect(
      mapJenkinsParameter({
        _class: "com.cloudbees.plugins.credentials.CredentialsParameterDefinition",
        name: "DEPLOY_KEY",
        description: "",
        credentialType: "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl",
      }),
    ).toEqual({
      type: "credentials",
      name: "DEPLOY_KEY",
      credentialType: "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl",
    });
  });

  it("falls back to type:unknown for unrecognised classes", () => {
    expect(
      mapJenkinsParameter({
        _class: "com.cwctravel.hudson.plugins.extended_choice_parameter.ExtendedChoiceParameterDefinition",
        name: "ECP",
        description: "Extended choice",
      }),
    ).toEqual({
      type: "unknown",
      name: "ECP",
      rawType: "com.cwctravel.hudson.plugins.extended_choice_parameter.ExtendedChoiceParameterDefinition",
      description: "Extended choice",
    });
  });

  it("strips empty description fields", () => {
    const out = mapJenkinsParameter({
      _class: "hudson.model.StringParameterDefinition",
      name: "FOO",
      description: "",
    });
    expect(out).toEqual({ type: "string", name: "FOO" });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- tests/utils/parameter-mapper.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement mapper**

`src/utils/parameter-mapper.ts`:
```ts
import type { ParameterSpec } from "../schemas/parameter.js";

export interface JenkinsParameterDefinition {
  _class?: string;
  name: string;
  description?: string;
  defaultParameterValue?: { value?: string | boolean | number };
  choices?: string[];
  projectName?: string;
  credentialType?: string;
}

function pruneDescription<T extends { description?: string }>(obj: T): T {
  if (!obj.description) {
    const { description: _omit, ...rest } = obj;
    return rest as T;
  }
  return obj;
}

export function mapJenkinsParameter(p: JenkinsParameterDefinition): ParameterSpec {
  const cls = p._class || "";
  const last = cls.split(".").pop() || "";
  const desc = p.description || undefined;
  const rawDefault = p.defaultParameterValue?.value;

  if (last === "StringParameterDefinition") {
    const out: ParameterSpec = { type: "string", name: p.name };
    if (typeof rawDefault === "string" && rawDefault !== "") out.default = rawDefault;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "TextParameterDefinition") {
    const out: ParameterSpec = { type: "text", name: p.name };
    if (typeof rawDefault === "string" && rawDefault !== "") out.default = rawDefault;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "BooleanParameterDefinition") {
    const out: ParameterSpec = { type: "boolean", name: p.name };
    if (typeof rawDefault === "boolean") out.default = rawDefault;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "ChoiceParameterDefinition" && p.choices && p.choices.length > 0) {
    const out: ParameterSpec = { type: "choice", name: p.name, choices: p.choices };
    if (typeof rawDefault === "string") out.default = rawDefault;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "PasswordParameterDefinition") {
    const out: ParameterSpec = { type: "password", name: p.name };
    if (desc) out.description = desc;
    return out;
  }
  if (last === "FileParameterDefinition") {
    const out: ParameterSpec = { type: "file", name: p.name };
    if (desc) out.description = desc;
    return out;
  }
  if (last === "RunParameterDefinition") {
    const out: ParameterSpec = { type: "run", name: p.name };
    if (p.projectName) out.projectName = p.projectName;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "CredentialsParameterDefinition") {
    const out: ParameterSpec = { type: "credentials", name: p.name };
    if (p.credentialType) out.credentialType = p.credentialType;
    if (desc) out.description = desc;
    return out;
  }
  const fallback: ParameterSpec = { type: "unknown", name: p.name, rawType: cls };
  if (desc) fallback.description = desc;
  return fallback;
}
```

(The `pruneDescription` helper is unused — remove it. The empty-string handling is already inline.)

After writing, remove the `pruneDescription` helper (it was a YAGNI-trap I added by reflex).

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- tests/utils/parameter-mapper.test.ts`

Expected: 9 passed.

- [ ] **Step 5: Register `getJobParameters` tool**

In `src/tools/jobs.ts`, add to imports:
```ts
import { mapJenkinsParameter, type JenkinsParameterDefinition } from "../utils/parameter-mapper.js";
import type { ParameterSpec } from "../schemas/parameter.js";
```

After the `getJobConfig` registration (around line 76, before `if (allowUnsafe)`), add:
```ts
// 3b. getJobParameters
register(
  "getJobParameters",
  "Get the structured parameter schema for a Jenkins job. Returns each parameter's type (string/choice/boolean/password/file/run/credentials/unknown), default, choices, and description as JSON. Use this instead of getJob when you need to know what to pass to triggerBuild.",
  z.object({
    jobPath: z.string().describe("Full job path"),
  }),
  async (args) => {
    const jobPath = args.jobPath as string;
    try {
      const tree = "property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices,projectName,credentialType,_class]]";
      const data = await client.get(jobPath, "/api/json", { tree });
      const job = data as {
        property?: Array<{ parameterDefinitions?: JenkinsParameterDefinition[] }>;
      };
      const defs = (job.property ?? []).flatMap((p) => p.parameterDefinitions ?? []);
      const parameters: ParameterSpec[] = defs.map(mapJenkinsParameter);
      return ok(JSON.stringify({ parameters }, null, 2));
    } catch (e) {
      return handleError(e);
    }
  },
);
```

- [ ] **Step 6: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/utils/parameter-mapper.ts tests/utils/parameter-mapper.test.ts src/tools/jobs.ts
git commit -m "feat: add getJobParameters returning structured ParameterSpec[]"
```

---

## Task 7: `getBuildLog` grep mode

**Files:**
- Create: `src/utils/log-grep.ts`
- Create: `tests/utils/log-grep.test.ts`
- Modify: `src/tools/builds.ts`

- [ ] **Step 1: Write failing tests for `grepLog`**

`tests/utils/log-grep.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { grepLog } from "../../src/utils/log-grep.js";

const sample = [
  "[INFO] Starting build",
  "[INFO] Compiling sources",
  "[INFO] Running tests",
  "[ERROR] Test failed: AuthSpec",
  "  expected 200 but got 401",
  "  at AuthSpec.scala:42",
  "[INFO] Cleaning up",
  "[ERROR] Build failed",
].join("\n");

describe("grepLog", () => {
  it("returns matches with surrounding context", () => {
    const out = grepLog(sample, { pattern: "ERROR", before: 1, after: 2 });
    expect(out.matches).toHaveLength(2);
    expect(out.matches[0].lineNumber).toBe(4);
    expect(out.matches[0].context).toEqual([
      { lineNumber: 3, text: "[INFO] Running tests" },
      { lineNumber: 4, text: "[ERROR] Test failed: AuthSpec" },
      { lineNumber: 5, text: "  expected 200 but got 401" },
      { lineNumber: 6, text: "  at AuthSpec.scala:42" },
    ]);
    expect(out.truncated).toBe(false);
  });

  it("supports regex mode", () => {
    const out = grepLog(sample, { pattern: "\\[ERROR\\] [A-Z]", regex: true, before: 0, after: 0 });
    expect(out.matches).toHaveLength(2);
  });

  it("does case-insensitive substring match by default", () => {
    const out = grepLog(sample, { pattern: "error", before: 0, after: 0 });
    expect(out.matches).toHaveLength(2);
  });

  it("truncates after maxMatches and reports truncated=true", () => {
    const out = grepLog(sample, { pattern: "INFO", maxMatches: 2, before: 0, after: 0 });
    expect(out.matches).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("rejects invalid regex with a clear error", () => {
    expect(() => grepLog(sample, { pattern: "[invalid", regex: true, before: 0, after: 0 })).toThrow(/Invalid regex/);
  });

  it("does not duplicate context lines when matches overlap", () => {
    const text = ["a", "b ERROR", "c", "d ERROR", "e"].join("\n");
    const out = grepLog(text, { pattern: "ERROR", before: 1, after: 1 });
    // matches at line 2 and line 4 with before=after=1 — line 3 is shared
    expect(out.matches).toHaveLength(2);
    // First match block: lines 1-3
    expect(out.matches[0].context.map((c) => c.lineNumber)).toEqual([1, 2, 3]);
    // Second match block: lines 3-5
    expect(out.matches[1].context.map((c) => c.lineNumber)).toEqual([3, 4, 5]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- tests/utils/log-grep.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `grepLog`**

`src/utils/log-grep.ts`:
```ts
export interface GrepOptions {
  pattern: string;
  regex?: boolean;
  before?: number;
  after?: number;
  maxMatches?: number;
}

export interface GrepMatch {
  lineNumber: number;
  text: string;
  context: Array<{ lineNumber: number; text: string }>;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

function buildMatcher(pattern: string, regex: boolean): (s: string) => boolean {
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid regex: ${msg}`);
    }
    return (s) => re.test(s);
  }
  const lower = pattern.toLowerCase();
  return (s) => s.toLowerCase().includes(lower);
}

export function grepLog(text: string, opts: GrepOptions): GrepResult {
  const before = opts.before ?? 0;
  const after = opts.after ?? 0;
  const maxMatches = opts.maxMatches ?? 50;
  const matches: GrepMatch[] = [];
  const lines = text.split("\n");
  const matcher = buildMatcher(opts.pattern, opts.regex ?? false);

  for (let i = 0; i < lines.length; i++) {
    if (!matcher(lines[i])) continue;

    const ctxStart = Math.max(0, i - before);
    const ctxEnd = Math.min(lines.length - 1, i + after);
    const context: Array<{ lineNumber: number; text: string }> = [];
    for (let j = ctxStart; j <= ctxEnd; j++) {
      context.push({ lineNumber: j + 1, text: lines[j] });
    }
    matches.push({ lineNumber: i + 1, text: lines[i], context });

    if (matches.length >= maxMatches) {
      // Check if there are any further matches; if so, signal truncation.
      for (let k = i + 1; k < lines.length; k++) {
        if (matcher(lines[k])) return { matches, truncated: true };
      }
      return { matches, truncated: false };
    }
  }

  return { matches, truncated: false };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- tests/utils/log-grep.test.ts`

Expected: 6 passed.

- [ ] **Step 5: Wire into `getBuildLog`**

In `src/tools/builds.ts`, replace the `getBuildLog` registration block (currently at lines 86-143). At the top, ensure:
```ts
import { grepLog } from "../utils/log-grep.js";
```

Replace the block:
```ts
register(
  "getBuildLog",
  "Get console output of a Jenkins build. Three modes: (a) tail (default — returns last `maxLines`), (b) byte-offset pagination via `startByte`, (c) grep mode if `pattern` is set (returns matches with `before`/`after` context lines). Modes are mutually exclusive — if `pattern` is set, tail/startByte are ignored.",
  z.object({
    jobPath: z.string().describe("Full job path"),
    buildNumber: z.number().optional().describe("Build number (default: last build)"),
    maxLines: z.number().optional().default(200).describe("[Tail mode] Maximum lines to return"),
    startByte: z.number().optional().describe("[Pagination mode] Byte offset to start from"),
    pattern: z.string().optional().describe("[Grep mode] Search pattern. Switches the tool to grep mode when set."),
    regex: z.boolean().optional().default(false).describe("[Grep mode] Treat pattern as regex (default: case-insensitive substring)"),
    before: z.number().optional().default(0).describe("[Grep mode] Lines of context before each match"),
    after: z.number().optional().default(0).describe("[Grep mode] Lines of context after each match"),
    maxMatches: z.number().optional().default(50).describe("[Grep mode] Stop after this many matches"),
  }),
  async (args) => {
    const jobPath = args.jobPath as string;
    const buildNumber = args.buildNumber as number | undefined;
    const maxLines = (args.maxLines as number) || 200;
    const startByte = args.startByte as number | undefined;
    const pattern = args.pattern as string | undefined;
    const regex = (args.regex as boolean) ?? false;
    const before = (args.before as number) ?? 0;
    const after = (args.after as number) ?? 0;
    const maxMatches = (args.maxMatches as number) ?? 50;
    const num = buildNumber ?? "lastBuild";

    try {
      // Grep mode
      if (pattern !== undefined) {
        const text = await client.getRaw(jobPath, `/${num}/consoleText`);
        let result;
        try {
          result = grepLog(text, { pattern, regex, before, after, maxMatches });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return error(msg);
        }
        const header = [
          `--- Build Log Search: pattern="${pattern}" (regex=${regex}, before=${before}, after=${after}) ---`,
          `Total matches: ${result.matches.length}${result.truncated ? ` (truncated at maxMatches=${maxMatches})` : ""}`,
          "",
        ];
        const blocks = result.matches.map((m) => {
          const ctxLines = m.context.map((c) => `${String(c.lineNumber).padStart(6)}: ${c.text}`);
          return `=== match #${result.matches.indexOf(m) + 1} (line ${m.lineNumber}) ===\n${ctxLines.join("\n")}`;
        });
        return ok(truncateText(header.join("\n") + blocks.join("\n\n")));
      }

      // Pagination mode
      if (startByte !== undefined) {
        const url = `/${num}/logText/progressiveText`;
        const data = await client.get(jobPath, url, { start: String(startByte) });
        const text = typeof data === "string" ? data : String(data);
        return ok(truncateText(text));
      }

      // Tail mode (default)
      const text = await client.getRaw(jobPath, `/${num}/consoleText`);
      const lines = text.split("\n");
      const totalLines = lines.length;
      let output: string;
      let hasMore = false;
      if (lines.length > maxLines) {
        output = lines.slice(lines.length - maxLines).join("\n");
        hasMore = true;
      } else {
        output = text;
      }
      const meta = [
        `--- Build Log (${totalLines} total lines, showing last ${Math.min(maxLines, totalLines)}) ---`,
      ];
      if (hasMore) {
        meta.push(`[Has more content. ${totalLines - maxLines} earlier lines not shown. Increase maxLines, use startByte, or use pattern for grep mode.]`);
      }
      meta.push("");
      return ok(truncateText(meta.join("\n") + output));
    } catch (e) {
      return handleError(e);
    }
  },
);
```

- [ ] **Step 6: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/utils/log-grep.ts tests/utils/log-grep.test.ts src/tools/builds.ts
git commit -m "feat: getBuildLog supports grep mode with regex and context lines"
```

---

## Task 8: `searchBuildLogs` v2 — regex, context, result filter, progressive read

**Files:**
- Modify: `src/jenkins-client.ts`
- Modify: `src/tools/discovery.ts`

- [ ] **Step 1: Add `getProgressiveText` to `JenkinsClient`**

In `src/jenkins-client.ts`, add a new public method (after `getRaw`, before `getAbsolute`):
```ts
/**
 * Stream a Jenkins console log chunk-by-chunk via /logText/progressiveText.
 * Yields chunks until the log ends. Caller can stop iteration early.
 * Falls back gracefully — if the endpoint returns 404, the caller should retry with /consoleText.
 */
async *getProgressiveText(
  jobPath: string,
  buildNumber: number | "lastBuild",
): AsyncGenerator<string, void, void> {
  let start = 0;
  const url = buildJenkinsUrl(this.config.url, jobPath, `/${buildNumber}/logText/progressiveText`);
  while (true) {
    const u = new URL(url);
    u.searchParams.set("start", String(start));
    const resp = await fetch(u.toString(), { headers: this.getHeaders() });
    if (!resp.ok) {
      await this.throwJenkinsError(resp);
    }
    const text = await resp.text();
    if (text.length > 0) yield text;
    const moreData = resp.headers.get("X-More-Data");
    const sizeHeader = resp.headers.get("X-Text-Size");
    if (moreData !== "true") return;
    const newStart = sizeHeader ? Number(sizeHeader) : start + text.length;
    if (newStart <= start) return; // protect against infinite loop
    start = newStart;
  }
}
```

(`buildJenkinsUrl` is already imported at the top of the file.)

- [ ] **Step 2: Extend `searchBuildLogs`**

In `src/tools/discovery.ts`, replace the entire `searchBuildLogs` registration block (currently lines 10-67) with:

```ts
// 16. searchBuildLogs (v2)
register(
  "searchBuildLogs",
  "Search build logs for a pattern across recent builds. Supports regex, context lines, result filter, and progressive read for large logs. Streams the log and stops early once maxMatchesPerBuild is hit per build.",
  z.object({
    jobPath: z.string().describe("Full job path"),
    pattern: z.string().describe("Pattern to search for"),
    buildNumber: z.number().optional().describe("Search a specific build only. Overrides lastN/onlyResults."),
    lastN: z.number().optional().default(5).describe("Number of recent builds to search (max 20)"),
    regex: z.boolean().optional().default(false).describe("Treat pattern as regex (default: case-insensitive substring)"),
    before: z.number().optional().default(0).describe("Lines of context before each match"),
    after: z.number().optional().default(0).describe("Lines of context after each match"),
    maxMatchesPerBuild: z.number().optional().default(10).describe("Stop scanning a build after this many matches"),
    onlyResults: z.array(z.enum(["SUCCESS", "FAILURE", "UNSTABLE", "ABORTED", "NOT_BUILT"])).optional()
      .describe("Filter builds by result before searching. Default: search all."),
  }),
  async (args) => {
    const jobPath = args.jobPath as string;
    const pattern = args.pattern as string;
    const buildNumber = args.buildNumber as number | undefined;
    const lastN = Math.min((args.lastN as number) || 5, 20);
    const regex = (args.regex as boolean) ?? false;
    const before = (args.before as number) ?? 0;
    const after = (args.after as number) ?? 0;
    const maxMatchesPerBuild = (args.maxMatchesPerBuild as number) ?? 10;
    const onlyResults = args.onlyResults as string[] | undefined;

    try {
      const matcher = (() => {
        try {
          return regex ? new RegExp(pattern) : null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Invalid regex: ${msg}`);
        }
      })();
      const isMatch = (line: string): boolean =>
        matcher ? matcher.test(line) : line.toLowerCase().includes(pattern.toLowerCase());

      // Determine which builds to search.
      let buildsToSearch: number[];
      if (buildNumber !== undefined) {
        buildsToSearch = [buildNumber];
      } else {
        const data = await client.get(jobPath, "/api/json", {
          tree: `builds[number,result]{0,${lastN}}`,
        });
        const jobData = data as { builds?: Array<{ number: number; result: string | null }> };
        const builds = jobData.builds ?? [];
        buildsToSearch = builds
          .filter((b) => !onlyResults || (b.result !== null && onlyResults.includes(b.result)))
          .map((b) => b.number);
      }

      const results: string[] = [];
      for (const num of buildsToSearch) {
        const matches = await searchOneBuild(client, jobPath, num, isMatch, before, after, maxMatchesPerBuild);
        if (matches.length === 0) continue;
        results.push(`Build #${num} (${matches.length}${matches.length >= maxMatchesPerBuild ? "+" : ""} matches):`);
        for (const m of matches.slice(0, maxMatchesPerBuild)) {
          for (const c of m.context) {
            results.push(`  ${String(c.lineNumber).padStart(6)}: ${c.text}`);
          }
          results.push("");
        }
      }

      if (results.length === 0) {
        return ok(`No matches for "${pattern}" in ${buildNumber ? `build #${buildNumber}` : `last ${buildsToSearch.length} build(s)`}.`);
      }
      return ok(truncateText(results.join("\n")));
    } catch (e) {
      return handleError(e);
    }
  },
);
```

Then replace the existing `searchBuildLog` helper at the bottom of the file with:
```ts
async function searchOneBuild(
  client: JenkinsClient,
  jobPath: string,
  buildNumber: number,
  isMatch: (line: string) => boolean,
  before: number,
  after: number,
  maxMatches: number,
): Promise<Array<{ lineNumber: number; context: Array<{ lineNumber: number; text: string }> }>> {
  const matches: Array<{ lineNumber: number; context: Array<{ lineNumber: number; text: string }> }> = [];
  let lineNumber = 0;
  // Sliding context buffer of recent lines.
  const tail: string[] = [];
  // Pending matches awaiting `after` lines.
  const pending: Array<{ lineNumber: number; collected: number; context: Array<{ lineNumber: number; text: string }> }> = [];
  let leftover = "";

  try {
    for await (const chunk of client.getProgressiveText(jobPath, buildNumber)) {
      const data = leftover + chunk;
      const lines = data.split("\n");
      // The last fragment may be a partial line — keep it for the next chunk.
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        lineNumber++;
        // Drain pending after-context.
        for (let i = pending.length - 1; i >= 0; i--) {
          const p = pending[i];
          p.context.push({ lineNumber, text: line });
          p.collected++;
          if (p.collected >= after) {
            matches.push({ lineNumber: p.lineNumber, context: p.context });
            pending.splice(i, 1);
          }
        }
        if (isMatch(line)) {
          const ctx: Array<{ lineNumber: number; text: string }> = [];
          // Take last `before` lines from tail.
          const startIdx = Math.max(0, tail.length - before);
          for (let j = startIdx; j < tail.length; j++) {
            ctx.push({ lineNumber: lineNumber - (tail.length - j), text: tail[j] });
          }
          ctx.push({ lineNumber, text: line });
          if (after === 0) {
            matches.push({ lineNumber, context: ctx });
          } else {
            pending.push({ lineNumber, collected: 0, context: ctx });
          }
          if (matches.length >= maxMatches) return matches;
        }
        tail.push(line);
        if (tail.length > before) tail.shift();
      }
    }
  } catch {
    // Fallback to /consoleText (e.g., progressiveText not available).
    const text = await client.getRaw(jobPath, `/${buildNumber}/consoleText`);
    return fallbackSearch(text, isMatch, before, after, maxMatches);
  }

  // Final flush: emit pending matches with whatever after-context we got.
  for (const p of pending) {
    matches.push({ lineNumber: p.lineNumber, context: p.context });
  }
  return matches.slice(0, maxMatches);
}

function fallbackSearch(
  text: string,
  isMatch: (line: string) => boolean,
  before: number,
  after: number,
  maxMatches: number,
): Array<{ lineNumber: number; context: Array<{ lineNumber: number; text: string }> }> {
  const lines = text.split("\n");
  const matches: Array<{ lineNumber: number; context: Array<{ lineNumber: number; text: string }> }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isMatch(lines[i])) continue;
    const ctx: Array<{ lineNumber: number; text: string }> = [];
    const start = Math.max(0, i - before);
    const end = Math.min(lines.length - 1, i + after);
    for (let j = start; j <= end; j++) {
      ctx.push({ lineNumber: j + 1, text: lines[j] });
    }
    matches.push({ lineNumber: i + 1, context: ctx });
    if (matches.length >= maxMatches) return matches;
  }
  return matches;
}
```

(Note: this replaces the previous helper. The `JenkinsClient` import is already present at the top of `discovery.ts`.)

- [ ] **Step 3: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero errors.

- [ ] **Step 4: Manual verification against a real Jenkins**

Pick a job with at least one failed build. Call `searchBuildLogs` with:
1. `pattern: "ERROR"`, `before: 2`, `after: 2`, `lastN: 3` — confirm matches come back with surrounding context.
2. `pattern: "\\bERROR\\b"`, `regex: true` — confirm regex mode.
3. `onlyResults: ["FAILURE"]` — confirm SUCCESS builds are skipped.

Record the verification result in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/jenkins-client.ts src/tools/discovery.ts
git commit -m "feat: searchBuildLogs v2 — regex, context, onlyResults, progressive streaming

- adds JenkinsClient.getProgressiveText async iterator over /logText/progressiveText
- searchBuildLogs streams chunks and stops early at maxMatchesPerBuild
- new optional onlyResults filter prunes builds before fetching their logs
- regex / before / after / maxMatchesPerBuild are all opt-in (backward-compatible)"
```

---

## Task 9: `describeJob` — structured config read

**Files:**
- Modify: `package.json`
- Create: `tests/fixtures/pipeline-config.xml`
- Create: `tests/fixtures/multibranch-config.xml`
- Create: `tests/fixtures/freestyle-config.xml`
- Create: `src/utils/job-xml.ts`
- Create: `tests/utils/job-xml.test.ts`
- Modify: `src/tools/jobs.ts`

- [ ] **Step 1: Add `fast-xml-parser` dependency**

```bash
npm install --save fast-xml-parser@^4.5.0
```

- [ ] **Step 2: Create XML fixtures**

`tests/fixtures/pipeline-config.xml`:
```xml
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job@1300.v8d6c5f0e2a3b">
  <description>Build and deploy the API</description>
  <keepDependencies>false</keepDependencies>
  <properties>
    <hudson.model.ParametersDefinitionProperty>
      <parameterDefinitions>
        <hudson.model.StringParameterDefinition>
          <name>BRANCH</name>
          <description>Git branch to build</description>
          <defaultValue>main</defaultValue>
          <trim>false</trim>
        </hudson.model.StringParameterDefinition>
        <hudson.model.BooleanParameterDefinition>
          <name>DRY_RUN</name>
          <description></description>
          <defaultValue>false</defaultValue>
        </hudson.model.BooleanParameterDefinition>
      </parameterDefinitions>
    </hudson.model.ParametersDefinitionProperty>
    <jenkins.model.BuildDiscarderProperty>
      <strategy class="hudson.tasks.LogRotator">
        <daysToKeep>30</daysToKeep>
        <numToKeep>50</numToKeep>
        <artifactDaysToKeep>-1</artifactDaysToKeep>
        <artifactNumToKeep>-1</artifactNumToKeep>
      </strategy>
    </jenkins.model.BuildDiscarderProperty>
  </properties>
  <triggers>
    <hudson.triggers.TimerTrigger>
      <spec>H 2 * * *</spec>
    </hudson.triggers.TimerTrigger>
  </triggers>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps@2.91">
    <scm class="hudson.plugins.git.GitSCM" plugin="git@5.0.0">
      <userRemoteConfigs>
        <hudson.plugins.git.UserRemoteConfig>
          <url>https://gitlab.example.com/my-team/api.git</url>
          <credentialsId>gitlab-token</credentialsId>
        </hudson.plugins.git.UserRemoteConfig>
      </userRemoteConfigs>
      <branches>
        <hudson.plugins.git.BranchSpec>
          <name>*/main</name>
        </hudson.plugins.git.BranchSpec>
      </branches>
    </scm>
    <scriptPath>deploy/Jenkinsfile</scriptPath>
    <lightweight>true</lightweight>
  </definition>
  <disabled>false</disabled>
</flow-definition>
```

`tests/fixtures/multibranch-config.xml`:
```xml
<?xml version='1.1' encoding='UTF-8'?>
<org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject plugin="workflow-multibranch">
  <description>Multibranch for API</description>
  <disabled>false</disabled>
  <sources class="jenkins.branch.MultiBranchProject$BranchSourceList">
    <data>
      <jenkins.branch.BranchSource>
        <source class="jenkins.plugins.git.GitSCMSource" plugin="git@5.0.0">
          <id>1</id>
          <remote>https://gitlab.example.com/my-team/api.git</remote>
          <credentialsId>gitlab-token</credentialsId>
        </source>
      </jenkins.branch.BranchSource>
    </data>
  </sources>
  <factory class="org.jenkinsci.plugins.workflow.multibranch.WorkflowBranchProjectFactory">
    <scriptPath>Jenkinsfile</scriptPath>
  </factory>
  <orphanedItemStrategy class="com.cloudbees.hudson.plugins.folder.computed.DefaultOrphanedItemStrategy">
    <pruneDeadBranches>true</pruneDeadBranches>
    <daysToKeep>14</daysToKeep>
    <numToKeep>-1</numToKeep>
  </orphanedItemStrategy>
</org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject>
```

`tests/fixtures/freestyle-config.xml`:
```xml
<?xml version='1.1' encoding='UTF-8'?>
<project>
  <description>Freestyle deploy job</description>
  <disabled>false</disabled>
  <concurrentBuild>true</concurrentBuild>
  <properties/>
  <scm class="hudson.scm.NullSCM"/>
  <builders>
    <hudson.tasks.Shell>
      <command>echo deploying</command>
    </hudson.tasks.Shell>
  </builders>
  <publishers/>
  <buildWrappers/>
</project>
```

- [ ] **Step 3: Write failing tests for `parseJobConfig`**

`tests/utils/job-xml.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJobConfig } from "../../src/utils/job-xml.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "../fixtures", name), "utf8");

describe("parseJobConfig", () => {
  it("parses a single-branch pipeline", () => {
    const out = parseJobConfig(fixture("pipeline-config.xml"));
    expect(out.type).toBe("pipeline");
    expect(out.description).toBe("Build and deploy the API");
    expect(out.disabled).toBe(false);
    expect(out.scm).toMatchObject({
      type: "git",
      url: "https://gitlab.example.com/my-team/api.git",
      credentialsId: "gitlab-token",
      jenkinsfilePath: "deploy/Jenkinsfile",
    });
    expect(out.scm?.branches).toEqual(["*/main"]);
    expect(out.parameters).toHaveLength(2);
    expect(out.parameters?.[0]).toMatchObject({ type: "string", name: "BRANCH", default: "main" });
    expect(out.parameters?.[1]).toMatchObject({ type: "boolean", name: "DRY_RUN" });
    expect(out.triggers?.cron).toBe("H 2 * * *");
    expect(out.buildRetention).toMatchObject({ daysToKeep: 30, numToKeep: 50 });
  });

  it("parses a multibranch project", () => {
    const out = parseJobConfig(fixture("multibranch-config.xml"));
    expect(out.type).toBe("multibranch");
    expect(out.scm).toMatchObject({
      type: "git",
      url: "https://gitlab.example.com/my-team/api.git",
      credentialsId: "gitlab-token",
      jenkinsfilePath: "Jenkinsfile",
    });
  });

  it("parses a freestyle project with limited fields and reports unknown elements", () => {
    const out = parseJobConfig(fixture("freestyle-config.xml"));
    expect(out.type).toBe("freestyle");
    expect(out.description).toBe("Freestyle deploy job");
    expect(out.concurrentBuilds).toBe(true);
    expect(out.unknownXmlElements).toEqual(expect.arrayContaining(["scm", "builders", "publishers"]));
  });

  it("returns type:unknown for unrecognised root elements", () => {
    const xml = `<?xml version='1.1' encoding='UTF-8'?><weird-root><foo/></weird-root>`;
    const out = parseJobConfig(xml);
    expect(out.type).toBe("unknown");
  });

  it("computes a stable rawConfigSha", () => {
    const xml = fixture("pipeline-config.xml");
    expect(parseJobConfig(xml).rawConfigSha).toBe(parseJobConfig(xml).rawConfigSha);
    expect(parseJobConfig(xml).rawConfigSha).not.toBe(parseJobConfig(xml + "\n").rawConfigSha);
  });
});
```

- [ ] **Step 4: Run, expect FAIL**

Run: `npm test -- tests/utils/job-xml.test.ts`

Expected: FAIL.

- [ ] **Step 5: Implement `parseJobConfig`**

`src/utils/job-xml.ts`:
```ts
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { mapJenkinsParameter, type JenkinsParameterDefinition } from "./parameter-mapper.js";
import type { ParameterSpec } from "../schemas/parameter.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

export interface JobDescription {
  type: "pipeline" | "multibranch" | "freestyle" | "folder" | "unknown";
  description?: string;
  disabled: boolean;
  concurrentBuilds: boolean;
  scm?: {
    type: "git" | "unknown";
    url?: string;
    branches?: string[];
    credentialsId?: string;
    jenkinsfilePath?: string;
  };
  triggers?: {
    cron?: string;
    scmPolling?: string;
  };
  parameters?: ParameterSpec[];
  buildRetention?: {
    numToKeep?: number;
    daysToKeep?: number;
  };
  unknownXmlElements: string[];
  rawConfigSha: string;
}

const KNOWN_ROOTS: Record<string, JobDescription["type"]> = {
  "flow-definition": "pipeline",
  "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject": "multibranch",
  "com.cloudbees.hudson.plugins.folder.Folder": "folder",
  project: "freestyle",
};

const PIPELINE_KNOWN = new Set(["description", "keepDependencies", "properties", "triggers", "definition", "disabled"]);
const MULTIBRANCH_KNOWN = new Set(["description", "disabled", "sources", "factory", "orphanedItemStrategy", "properties", "triggers"]);
const FREESTYLE_KNOWN = new Set(["description", "disabled", "concurrentBuild", "properties", "triggers"]);

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "#text" in v) return String((v as { "#text": unknown })["#text"]);
  return String(v);
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  const s = asString(v);
  if (s === "true") return true;
  if (s === "false") return false;
  return fallback;
}

function asNumber(v: unknown): number | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function extractParameters(properties: unknown): ParameterSpec[] | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const props = properties as Record<string, unknown>;
  const paramProp = props["hudson.model.ParametersDefinitionProperty"];
  if (!paramProp || typeof paramProp !== "object") return undefined;
  const defsContainer = (paramProp as Record<string, unknown>).parameterDefinitions;
  if (!defsContainer || typeof defsContainer !== "object") return undefined;
  const defs: JenkinsParameterDefinition[] = [];
  for (const [tag, raw] of Object.entries(defsContainer as Record<string, unknown>)) {
    for (const item of asArray(raw)) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const name = asString(obj.name);
      if (!name) continue;
      const description = asString(obj.description);
      const def: JenkinsParameterDefinition = {
        _class: tag,
        name,
        description,
        defaultParameterValue: { value: parseDefaultValue(tag, obj.defaultValue) },
      };
      if (tag === "hudson.model.ChoiceParameterDefinition") {
        const choicesNode = obj.choices as Record<string, unknown> | undefined;
        const stringList = choicesNode && typeof choicesNode === "object"
          ? choicesNode.a as Record<string, unknown> | undefined
          : undefined;
        const stringEntries = stringList && typeof stringList === "object"
          ? asArray(stringList.string).map(asString).filter((s): s is string => typeof s === "string")
          : [];
        def.choices = stringEntries;
      }
      defs.push(def);
    }
  }
  return defs.map(mapJenkinsParameter);
}

function parseDefaultValue(tag: string, raw: unknown): string | boolean | undefined {
  if (raw === undefined) return undefined;
  if (tag === "hudson.model.BooleanParameterDefinition") {
    const s = asString(raw);
    return s === "true";
  }
  return asString(raw);
}

function extractRetention(properties: unknown): JobDescription["buildRetention"] | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const props = properties as Record<string, unknown>;
  const disc = props["jenkins.model.BuildDiscarderProperty"];
  if (!disc || typeof disc !== "object") return undefined;
  const strategy = (disc as Record<string, unknown>).strategy;
  if (!strategy || typeof strategy !== "object") return undefined;
  const s = strategy as Record<string, unknown>;
  const out: JobDescription["buildRetention"] = {};
  const numToKeep = asNumber(s.numToKeep);
  const daysToKeep = asNumber(s.daysToKeep);
  if (numToKeep !== undefined && numToKeep > 0) out.numToKeep = numToKeep;
  if (daysToKeep !== undefined && daysToKeep > 0) out.daysToKeep = daysToKeep;
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractCronTrigger(triggers: unknown): string | undefined {
  if (!triggers || typeof triggers !== "object") return undefined;
  const t = (triggers as Record<string, unknown>)["hudson.triggers.TimerTrigger"];
  if (!t || typeof t !== "object") return undefined;
  return asString((t as Record<string, unknown>).spec);
}

function parsePipelineScm(definition: unknown): JobDescription["scm"] | undefined {
  if (!definition || typeof definition !== "object") return undefined;
  const def = definition as Record<string, unknown>;
  const scm = def.scm;
  const scriptPath = asString(def.scriptPath);
  if (!scm || typeof scm !== "object") {
    return scriptPath ? { type: "unknown", jenkinsfilePath: scriptPath } : undefined;
  }
  const scmCls = (scm as Record<string, unknown>)["@_class"];
  if (scmCls === "hudson.plugins.git.GitSCM") {
    const remote = (scm as Record<string, unknown>).userRemoteConfigs as Record<string, unknown> | undefined;
    const config = remote ? (remote["hudson.plugins.git.UserRemoteConfig"] as Record<string, unknown> | undefined) : undefined;
    const url = config ? asString(config.url) : undefined;
    const credentialsId = config ? asString(config.credentialsId) : undefined;
    const branchesNode = (scm as Record<string, unknown>).branches as Record<string, unknown> | undefined;
    const branches = branchesNode
      ? asArray(branchesNode["hudson.plugins.git.BranchSpec"]).map((b) => asString((b as Record<string, unknown>).name)).filter((b): b is string => !!b)
      : undefined;
    const out: JobDescription["scm"] = { type: "git" };
    if (url) out.url = url;
    if (credentialsId) out.credentialsId = credentialsId;
    if (branches && branches.length > 0) out.branches = branches;
    if (scriptPath) out.jenkinsfilePath = scriptPath;
    return out;
  }
  return scriptPath ? { type: "unknown", jenkinsfilePath: scriptPath } : { type: "unknown" };
}

function parseMultibranchScm(sources: unknown, factory: unknown): JobDescription["scm"] | undefined {
  const factoryScript = factory && typeof factory === "object"
    ? asString((factory as Record<string, unknown>).scriptPath)
    : undefined;
  const data = sources && typeof sources === "object"
    ? (sources as Record<string, unknown>).data
    : undefined;
  const branchSource = data && typeof data === "object"
    ? (data as Record<string, unknown>)["jenkins.branch.BranchSource"] as Record<string, unknown> | undefined
    : undefined;
  const source = branchSource ? branchSource.source as Record<string, unknown> | undefined : undefined;
  if (!source) {
    return factoryScript ? { type: "unknown", jenkinsfilePath: factoryScript } : undefined;
  }
  const sourceCls = source["@_class"];
  const out: JobDescription["scm"] = { type: sourceCls === "jenkins.plugins.git.GitSCMSource" ? "git" : "unknown" };
  const url = asString(source.remote);
  const credentialsId = asString(source.credentialsId);
  if (url) out.url = url;
  if (credentialsId) out.credentialsId = credentialsId;
  if (factoryScript) out.jenkinsfilePath = factoryScript;
  return out;
}

function listUnknownChildren(node: Record<string, unknown>, known: Set<string>): string[] {
  return Object.keys(node).filter((k) => !k.startsWith("@_") && k !== "?xml" && !known.has(k));
}

export function parseJobConfig(xml: string): JobDescription {
  const sha = createHash("sha256").update(xml).digest("hex").slice(0, 12);
  const tree = parser.parse(xml) as Record<string, unknown>;

  const rootEntry = Object.entries(tree).find(([k]) => k !== "?xml");
  const rootName = rootEntry?.[0] ?? "";
  const rootNode = (rootEntry?.[1] as Record<string, unknown>) ?? {};
  const type = KNOWN_ROOTS[rootName] ?? "unknown";

  if (type === "unknown") {
    return { type, disabled: false, concurrentBuilds: false, unknownXmlElements: [rootName], rawConfigSha: sha };
  }

  const description = asString(rootNode.description);
  const disabled = asBoolean(rootNode.disabled, false);
  const concurrentBuilds = type === "freestyle" ? asBoolean(rootNode.concurrentBuild, false) : false;
  const properties = rootNode.properties;
  const parameters = extractParameters(properties);
  const buildRetention = extractRetention(properties);
  const cron = extractCronTrigger(rootNode.triggers);

  let scm: JobDescription["scm"] | undefined;
  let unknownChildren: string[];

  if (type === "pipeline") {
    scm = parsePipelineScm(rootNode.definition);
    unknownChildren = listUnknownChildren(rootNode, PIPELINE_KNOWN);
  } else if (type === "multibranch") {
    scm = parseMultibranchScm(rootNode.sources, rootNode.factory);
    unknownChildren = listUnknownChildren(rootNode, MULTIBRANCH_KNOWN);
  } else if (type === "freestyle") {
    unknownChildren = listUnknownChildren(rootNode, FREESTYLE_KNOWN);
  } else {
    unknownChildren = [];
  }

  const out: JobDescription = {
    type,
    disabled,
    concurrentBuilds,
    unknownXmlElements: unknownChildren,
    rawConfigSha: sha,
  };
  if (description) out.description = description;
  if (scm) out.scm = scm;
  if (cron) out.triggers = { cron };
  if (parameters && parameters.length > 0) out.parameters = parameters;
  if (buildRetention) out.buildRetention = buildRetention;
  return out;
}
```

- [ ] **Step 6: Run tests, expect PASS**

Run: `npm test -- tests/utils/job-xml.test.ts`

Expected: 5 passed.

- [ ] **Step 7: Register `describeJob` tool**

In `src/tools/jobs.ts`, add to imports:
```ts
import { parseJobConfig } from "../utils/job-xml.js";
```

After the `getJobParameters` registration block from Task 6, add:
```ts
// 3c. describeJob
register(
  "describeJob",
  "Get a structured view of a job's config (SCM url/branch, Jenkinsfile path, parameters, retention, cron) without parsing raw XML. Reports unrecognised XML elements via 'unknownXmlElements'. Read-only and safe.",
  z.object({
    jobPath: z.string().describe("Full job path"),
  }),
  async (args) => {
    const jobPath = args.jobPath as string;
    try {
      const xml = await client.getRaw(jobPath, "/config.xml");
      const desc = parseJobConfig(xml);
      return ok(JSON.stringify(desc, null, 2));
    } catch (e) {
      return handleError(e);
    }
  },
);
```

- [ ] **Step 8: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/utils/job-xml.ts tests/utils/job-xml.test.ts tests/fixtures/ src/tools/jobs.ts
git commit -m "feat: add describeJob — structured config.xml read

- adds fast-xml-parser dependency
- parses pipeline (CpsScmFlowDefinition + GitSCM), multibranch (GitSCMSource), folder, and freestyle (limited)
- reports unrecognised elements via unknownXmlElements
- returns rawConfigSha for future optimistic concurrency"
```

---

## Task 10: `previewJobConfig` — codegen and structured diff

**Files:**
- Modify: `src/utils/job-xml.ts`
- Create: `src/utils/job-diff.ts`
- Create: `tests/utils/job-diff.test.ts`
- Modify: `tests/utils/job-xml.test.ts`
- Modify: `src/tools/jobs.ts`

- [ ] **Step 1: Define the spec input schema**

Append to `src/utils/job-xml.ts` (top of file, before the `JobDescription` interface):
```ts
export interface PipelineSpec {
  type: "pipeline";
  description?: string;
  disabled?: boolean;
  scm: {
    type: "git";
    url: string;
    branches?: string[];
    credentialsId?: string;
    jenkinsfilePath?: string;
  };
  triggers?: { cron?: string };
  parameters?: ParameterSpec[];
  buildRetention?: { numToKeep?: number; daysToKeep?: number };
}
export interface MultibranchSpec {
  type: "multibranch";
  description?: string;
  source: {
    type: "git";
    url: string;
    credentialsId?: string;
  };
  jenkinsfilePath?: string;
  orphanedItemStrategy?: { numToKeep?: number; daysToKeep?: number };
}
export interface FolderSpec {
  type: "folder";
  description?: string;
}
export type JobSpec = PipelineSpec | MultibranchSpec | FolderSpec;
```

- [ ] **Step 2: Write failing tests for `buildJobXml`**

Append to `tests/utils/job-xml.test.ts`:
```ts
import { buildJobXml, parseJobConfig as parseAgain } from "../../src/utils/job-xml.js";

describe("buildJobXml", () => {
  it("builds a pipeline XML that round-trips through parseJobConfig", () => {
    const spec = {
      type: "pipeline" as const,
      description: "Test pipeline",
      disabled: false,
      scm: {
        type: "git" as const,
        url: "https://example.com/repo.git",
        branches: ["main"],
        credentialsId: "my-cred",
        jenkinsfilePath: "Jenkinsfile",
      },
      triggers: { cron: "H 5 * * *" },
      parameters: [{ type: "string" as const, name: "BRANCH", default: "main" }],
      buildRetention: { numToKeep: 20 },
    };
    const xml = buildJobXml(spec);
    const parsed = parseAgain(xml);
    expect(parsed.type).toBe("pipeline");
    expect(parsed.description).toBe("Test pipeline");
    expect(parsed.scm).toMatchObject({ type: "git", url: "https://example.com/repo.git", credentialsId: "my-cred", jenkinsfilePath: "Jenkinsfile" });
    expect(parsed.scm?.branches).toEqual(["main"]);
    expect(parsed.parameters?.[0]).toMatchObject({ type: "string", name: "BRANCH", default: "main" });
    expect(parsed.triggers?.cron).toBe("H 5 * * *");
    expect(parsed.buildRetention?.numToKeep).toBe(20);
  });

  it("builds a multibranch XML", () => {
    const xml = buildJobXml({
      type: "multibranch" as const,
      description: "MB",
      source: { type: "git" as const, url: "https://example.com/r.git" },
      jenkinsfilePath: "Jenkinsfile",
    });
    const parsed = parseAgain(xml);
    expect(parsed.type).toBe("multibranch");
    expect(parsed.scm).toMatchObject({ type: "git", url: "https://example.com/r.git", jenkinsfilePath: "Jenkinsfile" });
  });

  it("builds a folder XML", () => {
    const xml = buildJobXml({ type: "folder" as const, description: "My folder" });
    expect(xml).toContain("<com.cloudbees.hudson.plugins.folder.Folder");
    expect(xml).toContain("<description>My folder</description>");
  });

  it("XML-escapes user input", () => {
    const xml = buildJobXml({
      type: "folder" as const,
      description: "Has <evil> & \"quotes\"",
    });
    expect(xml).not.toContain("<evil>");
    expect(xml).toContain("&lt;evil&gt;");
    expect(xml).toContain("&amp;");
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `npm test -- tests/utils/job-xml.test.ts`

Expected: FAIL — `buildJobXml` not exported.

- [ ] **Step 4: Implement `buildJobXml`**

Append to `src/utils/job-xml.ts`:
```ts
import { XMLBuilder } from "fast-xml-parser";

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: false,
  // fast-xml-parser handles entity escaping for content; attributes are also escaped.
});

function paramDefXml(p: ParameterSpec): { tag: string; body: Record<string, unknown> } {
  if (p.type === "string") {
    return {
      tag: "hudson.model.StringParameterDefinition",
      body: { name: p.name, description: p.description ?? "", defaultValue: p.default ?? "", trim: p.trim ?? false },
    };
  }
  if (p.type === "text") {
    return {
      tag: "hudson.model.TextParameterDefinition",
      body: { name: p.name, description: p.description ?? "", defaultValue: p.default ?? "" },
    };
  }
  if (p.type === "boolean") {
    return {
      tag: "hudson.model.BooleanParameterDefinition",
      body: { name: p.name, description: p.description ?? "", defaultValue: String(p.default ?? false) },
    };
  }
  if (p.type === "choice") {
    return {
      tag: "hudson.model.ChoiceParameterDefinition",
      body: {
        name: p.name,
        description: p.description ?? "",
        choices: { "@_class": "java.util.Arrays$ArrayList", a: { "@_class": "string-array", string: p.choices } },
      },
    };
  }
  if (p.type === "password") {
    return {
      tag: "hudson.model.PasswordParameterDefinition",
      body: { name: p.name, description: p.description ?? "", defaultValue: "" },
    };
  }
  if (p.type === "file") {
    return { tag: "hudson.model.FileParameterDefinition", body: { name: p.name, description: p.description ?? "" } };
  }
  if (p.type === "run") {
    return {
      tag: "hudson.model.RunParameterDefinition",
      body: { name: p.name, description: p.description ?? "", projectName: p.projectName ?? "" },
    };
  }
  if (p.type === "credentials") {
    return {
      tag: "com.cloudbees.plugins.credentials.CredentialsParameterDefinition",
      body: { name: p.name, description: p.description ?? "", credentialType: p.credentialType ?? "" },
    };
  }
  // unknown — emit as a comment marker; the user must replace it.
  return {
    tag: "hudson.model.StringParameterDefinition",
    body: { name: p.name, description: `[UNKNOWN ORIGINAL TYPE: ${p.rawType}] ${p.description ?? ""}`, defaultValue: "" },
  };
}

function buildPipelineRoot(spec: PipelineSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (spec.parameters && spec.parameters.length > 0) {
    const grouped: Record<string, Array<Record<string, unknown>>> = {};
    for (const p of spec.parameters) {
      const { tag, body } = paramDefXml(p);
      (grouped[tag] ??= []).push(body);
    }
    properties["hudson.model.ParametersDefinitionProperty"] = { parameterDefinitions: grouped };
  }
  if (spec.buildRetention) {
    properties["jenkins.model.BuildDiscarderProperty"] = {
      strategy: {
        "@_class": "hudson.tasks.LogRotator",
        daysToKeep: String(spec.buildRetention.daysToKeep ?? -1),
        numToKeep: String(spec.buildRetention.numToKeep ?? -1),
        artifactDaysToKeep: "-1",
        artifactNumToKeep: "-1",
      },
    };
  }
  const triggers: Record<string, unknown> = {};
  if (spec.triggers?.cron) {
    triggers["hudson.triggers.TimerTrigger"] = { spec: spec.triggers.cron };
  }
  const definition = {
    "@_class": "org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition",
    "@_plugin": "workflow-cps",
    scm: {
      "@_class": "hudson.plugins.git.GitSCM",
      "@_plugin": "git",
      userRemoteConfigs: {
        "hudson.plugins.git.UserRemoteConfig": {
          url: spec.scm.url,
          ...(spec.scm.credentialsId ? { credentialsId: spec.scm.credentialsId } : {}),
        },
      },
      branches: {
        "hudson.plugins.git.BranchSpec": (spec.scm.branches ?? ["*/main"]).map((name) => ({ name })),
      },
    },
    scriptPath: spec.scm.jenkinsfilePath ?? "Jenkinsfile",
    lightweight: "true",
  };
  return {
    "flow-definition": {
      "@_plugin": "workflow-job",
      description: spec.description ?? "",
      keepDependencies: "false",
      ...(Object.keys(properties).length > 0 ? { properties } : { properties: "" }),
      ...(Object.keys(triggers).length > 0 ? { triggers } : {}),
      definition,
      disabled: String(spec.disabled ?? false),
    },
  };
}

function buildMultibranchRoot(spec: MultibranchSpec): Record<string, unknown> {
  return {
    "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject": {
      "@_plugin": "workflow-multibranch",
      description: spec.description ?? "",
      disabled: "false",
      sources: {
        "@_class": "jenkins.branch.MultiBranchProject$BranchSourceList",
        data: {
          "jenkins.branch.BranchSource": {
            source: {
              "@_class": "jenkins.plugins.git.GitSCMSource",
              "@_plugin": "git",
              id: "1",
              remote: spec.source.url,
              ...(spec.source.credentialsId ? { credentialsId: spec.source.credentialsId } : {}),
            },
          },
        },
      },
      factory: {
        "@_class": "org.jenkinsci.plugins.workflow.multibranch.WorkflowBranchProjectFactory",
        scriptPath: spec.jenkinsfilePath ?? "Jenkinsfile",
      },
      ...(spec.orphanedItemStrategy
        ? {
            orphanedItemStrategy: {
              "@_class": "com.cloudbees.hudson.plugins.folder.computed.DefaultOrphanedItemStrategy",
              pruneDeadBranches: "true",
              daysToKeep: String(spec.orphanedItemStrategy.daysToKeep ?? -1),
              numToKeep: String(spec.orphanedItemStrategy.numToKeep ?? -1),
            },
          }
        : {}),
    },
  };
}

function buildFolderRoot(spec: FolderSpec): Record<string, unknown> {
  return {
    "com.cloudbees.hudson.plugins.folder.Folder": {
      "@_plugin": "cloudbees-folder",
      description: spec.description ?? "",
    },
  };
}

export function buildJobXml(spec: JobSpec): string {
  let body: Record<string, unknown>;
  if (spec.type === "pipeline") body = buildPipelineRoot(spec);
  else if (spec.type === "multibranch") body = buildMultibranchRoot(spec);
  else body = buildFolderRoot(spec);
  const xml = builder.build(body) as string;
  return `<?xml version='1.1' encoding='UTF-8'?>\n${xml}`;
}
```

- [ ] **Step 5: Run, expect PASS**

Run: `npm test -- tests/utils/job-xml.test.ts`

Expected: existing 5 + 4 new = 9 passed. If round-trip parses don't match exactly (e.g. `branches` differ because the parser reads `*/main` from the existing fixture but the builder emits `main`), update the test expectation to whichever the builder actually produces — the round-trip equivalence is the contract; cosmetic prefix differences are fine if both sides agree.

- [ ] **Step 6: Implement `diffJobSpecs`**

`src/utils/job-diff.ts`:
```ts
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
```

- [ ] **Step 7: Tests for `diffJobSpecs`**

`tests/utils/job-diff.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { diffJobSpecs } from "../../src/utils/job-diff.js";
import type { JobDescription } from "../../src/utils/job-xml.js";

const base: JobDescription = {
  type: "pipeline",
  description: "old desc",
  disabled: false,
  concurrentBuilds: false,
  scm: { type: "git", url: "https://e.com/r.git", branches: ["main"], jenkinsfilePath: "Jenkinsfile" },
  unknownXmlElements: [],
  rawConfigSha: "abc",
};

describe("diffJobSpecs", () => {
  it("detects a description change", () => {
    const out = diffJobSpecs(base, { ...base, description: "new desc" });
    expect(out).toEqual([{ path: "description", before: "old desc", after: "new desc" }]);
  });

  it("detects a nested scm field change", () => {
    const out = diffJobSpecs(base, { ...base, scm: { ...base.scm!, url: "https://e.com/r2.git" } });
    expect(out).toEqual([{ path: "scm.url", before: "https://e.com/r.git", after: "https://e.com/r2.git" }]);
  });

  it("ignores rawConfigSha", () => {
    const out = diffJobSpecs(base, { ...base, rawConfigSha: "xyz" });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 8: Run, expect PASS**

Run: `npm test -- tests/utils/job-diff.test.ts`

Expected: 3 passed.

- [ ] **Step 9: Register `previewJobConfig` tool**

In `src/tools/jobs.ts`, add to imports:
```ts
import { buildJobXml, type JobSpec } from "../utils/job-xml.js";
import { diffJobSpecs } from "../utils/job-diff.js";
import { parameterSpec } from "../schemas/parameter.js";
```

Add a Zod schema for the spec input near the top of the file (above the `registerJobTools` export):
```ts
const pipelineSpecSchema = z.object({
  type: z.literal("pipeline"),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
  scm: z.object({
    type: z.literal("git"),
    url: z.string(),
    branches: z.array(z.string()).optional(),
    credentialsId: z.string().optional(),
    jenkinsfilePath: z.string().optional(),
  }),
  triggers: z.object({ cron: z.string().optional() }).optional(),
  parameters: z.array(parameterSpec).optional(),
  buildRetention: z.object({ numToKeep: z.number().optional(), daysToKeep: z.number().optional() }).optional(),
});

const multibranchSpecSchema = z.object({
  type: z.literal("multibranch"),
  description: z.string().optional(),
  source: z.object({
    type: z.literal("git"),
    url: z.string(),
    credentialsId: z.string().optional(),
  }),
  jenkinsfilePath: z.string().optional(),
  orphanedItemStrategy: z.object({ numToKeep: z.number().optional(), daysToKeep: z.number().optional() }).optional(),
});

const folderSpecSchema = z.object({
  type: z.literal("folder"),
  description: z.string().optional(),
});

const jobSpecSchema = z.discriminatedUnion("type", [pipelineSpecSchema, multibranchSpecSchema, folderSpecSchema]);
```

After the `describeJob` registration, add:
```ts
// 3d. previewJobConfig
register(
  "previewJobConfig",
  "Generate Jenkins job XML config from a structured spec. Optionally diff against an existing job's current config (read-only — does not modify Jenkins). Use the resulting XML with updateJobConfig (gated by JENKINS_ALLOW_UNSAFE_OPERATIONS) once it looks right.",
  z.object({
    spec: jobSpecSchema,
    diffAgainstJobPath: z.string().optional().describe("If set, fetch the current config of this job and emit a structured diff."),
  }),
  async (args) => {
    const spec = args.spec as JobSpec;
    const diffPath = args.diffAgainstJobPath as string | undefined;
    try {
      const xml = buildJobXml(spec);
      const out: string[] = [`=== Generated config.xml (${spec.type}) ===`, xml];
      if (diffPath) {
        const currentXml = await client.getRaw(diffPath, "/config.xml");
        const before = parseJobConfig(currentXml);
        const after = parseJobConfig(xml);
        const changes = diffJobSpecs(before, after);
        out.push(`\n=== Diff against ${diffPath} ===`);
        if (changes.length === 0) {
          out.push("(no structural changes)");
        } else {
          for (const c of changes) {
            out.push(`@@ ${c.path} @@`);
            out.push(`- ${c.before}`);
            out.push(`+ ${c.after}`);
          }
        }
        if (before.unknownXmlElements.length > 0) {
          out.push(`\n(skipped: ${before.unknownXmlElements.join(", ")})`);
        }
      }
      return ok(out.join("\n"));
    } catch (e) {
      return handleError(e);
    }
  },
);
```

- [ ] **Step 10: Lint + build**

Run: `npm run lint && npm run build`

Expected: zero errors.

- [ ] **Step 11: Commit**

```bash
git add src/utils/job-xml.ts src/utils/job-diff.ts tests/utils/job-xml.test.ts tests/utils/job-diff.test.ts src/tools/jobs.ts
git commit -m "feat: add previewJobConfig — codegen XML + structured diff

- supports pipeline (Git SCM + parameters + retention + cron), multibranch (Git source), and folder
- diff is structured: field-level changes between parsed before/after JobDescription
- no Jenkins side-effects; XML is intended for use with updateJobConfig"
```

---

## Task 11: README + version bump

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Bump version**

Edit `package.json`: change `"version": "1.0.1"` to `"version": "1.2.0"`.

(Skip 1.1.0 because the CI release job auto-bumped to 1.1.0 during the earlier release cycle. We're declaring 1.2.0 here as the brought-up baseline. If the auto-release ran since then and bumped to 1.1.0 already, leave whatever the current version is and let CI bump on merge.)

- [ ] **Step 2: Update README**

Replace the version banner at the top of `README.md`:
```markdown
# @alexsarrell/jenkins-mcp-server v1.2.0

A custom MCP (Model Context Protocol) server for Jenkins integration with Claude Code. Provides 22 tools (20 default + 2 unsafe) for comprehensive Jenkins management including pipeline replay, stage-level logs, structured config reads, parameter introspection, and rich log search.
```

Replace the "Tools (16 default + 2 unsafe)" section heading with "Tools (20 default + 2 unsafe)" and add four entries:

Under **Job Management**, add:
- **getJobParameters** - Structured `ParameterSpec[]` for the job (types, choices, defaults). Use this before `triggerBuild` to know what to pass.
- **describeJob** - Structured read of `config.xml` (SCM url/branch, Jenkinsfile path, parameters, cron, retention) without parsing raw XML.
- **previewJobConfig** - Generate a `config.xml` from a structured spec (pipeline / multibranch / folder), optionally diffed against an existing job. Read-only.

Under **Discovery & Utilities**, add:
- **getQueueItem** - Map a queue item ID (returned by `triggerBuild`) to the build that started, or its current waiting/cancelled state.

Update `triggerBuild`'s description to mention multi-value via `string[]` and add a "## Multi-value parameters" subsection under "## Notes":
```markdown
### Multi-value parameters

`triggerBuild` accepts each parameter value as either a string or a string array. The string form is **never** split on commas — passing `"hello, world"` sends one value verbatim. For multi-select / `ExtendedChoiceParameter (PT_CHECKBOX)` parameters, pass an array:

```js
triggerBuild({ jobPath: "x", parameters: { TAGS: ["alpha", "beta", "gamma"] } });
```

A legacy `splitOnComma: true` flag preserves the pre-1.2 behaviour (split string values on commas) — deprecated, will be removed in v2.0.
```

Under "## Tools" add a paragraph after the list:
```markdown
### Log search and grep

Both `getBuildLog` and `searchBuildLogs` accept a `pattern` (with optional `regex`) and `before`/`after` context lines. `getBuildLog` switches to grep mode when `pattern` is set; otherwise it returns a tail. `searchBuildLogs` streams logs via Jenkins' progressive-text API and stops early once `maxMatchesPerBuild` is reached, and an `onlyResults: ["FAILURE"]` filter prunes builds before fetching their logs.
```

- [ ] **Step 3: Lint + build + full test**

Run: `npm run lint && npm run build && npm test`

Expected: zero errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "feat: v1.2.0 — bump version and document new tools

22 tools (20 default + 2 unsafe). New: getJobParameters, getQueueItem,
describeJob, previewJobConfig. Extended: triggerBuild (multi-value),
getBuild (parameters/include), getBuildLog (grep), searchBuildLogs (regex,
context, onlyResults, progressive read)."
```

---

## Final verification checklist

After Task 11, run from project root:

```bash
npm run lint
npm run build
npm test
```

All three must succeed. Then a manual smoke against a real Jenkins instance:

1. `getJobParameters` on a job with mixed parameter types — confirm `ParameterSpec[]` looks correct.
2. `triggerBuild` with `parameters: { TAGS: ["a","b","c"] }` — confirm multi-value submission in Jenkins.
3. `getQueueItem` on the queue ID returned above — confirm `LEFT_QUEUE` plus build number once it starts.
4. `getBuild` with default `include` — confirm the `Parameters` block appears.
5. `getBuildLog` with `pattern: "ERROR"`, `before: 2`, `after: 2` — confirm match blocks.
6. `searchBuildLogs` with `onlyResults: ["FAILURE"]` — confirm SUCCESS builds skipped.
7. `describeJob` on a real pipeline — confirm scm/parameters fields populated.
8. `previewJobConfig` with a small pipeline spec, `diffAgainstJobPath` set — confirm structured diff.

Push the branch when all eight pass; CI auto-releases v1.2.0 on merge to `main`.

---

## Self-Review (completed)

**Spec coverage.** Each of §5.1–§5.8 in the spec maps to a task: §5.1→T3, §5.2→T4, §5.3→T5, §5.4→T6, §5.5→T9, §5.6→T10, §5.7→T7, §5.8→T8. The shared `ParameterSpec` (§4.1) is T2; `fast-xml-parser` introduction (§4.2) lands inside T9; backward-compat (§4.3) is enforced via the `include` default in T4 and the `splitOnComma` opt-in in T3. Vitest setup (§8 Option B) is T1. Documentation/version (§8 acceptance + §3 deferred-list ack) is T11.

**Placeholder scan.** No "TBD" / "implement later" / "add error handling" lines remain. Every code step has runnable code; every commit step has a real message.

**Type consistency.** `ParameterSpec` (T2) is consumed by the same name in T6 (`mapJenkinsParameter`), T9 (`extractParameters` in `parseJobConfig`), and T10 (`paramDefXml` in `buildJobXml`). `JobDescription` is defined in T9 and consumed in T10's `diffJobSpecs`. `JobSpec` discriminated union is defined in T10 and used by `buildJobXml`. `JsonParameter` (T3) is computed but unused — wired via `void jsonParameters` to silence the compiler, with a commit-message note explaining the v1.3 follow-up.

**Inline fix applied.** During review I noticed `mapJenkinsParameter` referenced an unused helper (`pruneDescription`); the task now instructs the engineer to remove it after writing.
