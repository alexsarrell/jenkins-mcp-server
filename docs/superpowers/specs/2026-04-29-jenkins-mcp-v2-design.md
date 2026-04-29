---
title: Jenkins MCP server v1.2 — design
date: 2026-04-29
status: approved (brainstorm phase)
target_version: 1.2.0 (backward-compatible feature release)
authors: a.popov + Claude Code multi-agent team (dx-analyst, job-architect, observability-lead)
---

# Jenkins MCP server v1.2 — design

## 1. Background

The current server (v1.0.1) exposes 18 tools across job/build/pipeline/discovery groups. After running the server in production we surfaced eight concrete pain points. They cluster into three categories:

1. **Parameterised builds are fragile and lossy.** `triggerBuild` accepts `Record<string, string>` and self-splits on commas (`builds.ts:29`) — values containing a literal comma are silently corrupted. Parameter definitions are returned as plain text (`formatters.ts:87-94`) so the model has to guess types, choices, and defaults. There is no way to learn what parameters a finished build actually ran with — `getBuild` does not include them.
2. **No bridge between queue and build.** `triggerBuild` returns a queue-item URL, but nothing consumes it: `getQueue` only shows pending items, and once a build starts there is no programmatic way to map `queue/item/123` → `build #42`. Every "trigger and find out the build number" flow is manual and brittle.
3. **Job configuration is read/written as raw XML.** `getJobConfig`/`updateJobConfig` round-trip the entire `config.xml`. There is no structured read for SCM URL / branch / Jenkinsfile path / parameters / triggers / retention. A user who only wants to confirm "is this job pointed at `main`?" must download and parse XML by hand.
4. **Log access is coarse.** `getBuildLog` returns either a 200-line tail or a byte-offset slice. There is no in-tool grep with context — a user who knows the failure says `ERROR: Failed to compile` cannot get the surrounding 5 lines without round-tripping the entire log. `searchBuildLogs` does linear substring grep over the **full** `consoleText` of every searched build, with no regex, no context lines, and no early termination.

## 2. Goals

- Close the eight pain points with **backward-compatible** additions and extensions. No breaking changes to existing tool signatures.
- Keep dependencies minimal: at most one new package (`fast-xml-parser`).
- Add no new env flags. Reuse the existing `JENKINS_ALLOW_UNSAFE_OPERATIONS` gate where applicable. (None of the v1.2 tools are write-side — see §6.)
- Surface structured data the model can reason about (typed parameter definitions, parsed job-config subset) instead of only formatted text.
- Hold response sizes under the existing 100 KB ceiling without truncation for the common case.

## 3. Non-goals

The following ideas surfaced during brainstorming but are explicitly out of scope for v1.2. Each has a reason captured here so we don't relitigate during implementation.

- **`patchJobConfig` / `createPipelineJob` / `copyJob` (declarative job-config writes).** High value but L-sized: needs a stable XPath/op set, plugin-XML compatibility surface, and optimistic-concurrency story. Defer to v1.3+. The existing `updateJobConfig` (already gated by `JENKINS_ALLOW_UNSAFE_OPERATIONS`) plus the new `previewJobConfig` cover the "generate XML, paste into update" flow well enough to validate demand first.
- **`triggerAndWait` / `waitForBuild` (sync triggers with polling).** Composable from `triggerBuild` + `getQueueItem` + `getBuild` once the queue→build bridge exists. Add later if call-site verbosity becomes a real complaint.
- **`getFailureSummary`, `compareBuilds`, `getJobTrends`, `getNodes`, `getTestStability`.** Observability/diagnostic tools. They compose cleanly from existing primitives via the model itself; bare composition first, dedicated tools only after we measure that the composition cost is too high.
- **`findStuckBuilds`, `findFlakyJobs`.** Heavy recursive scans, real DDoS risk against Jenkins. Postpone until there's a concrete user request and a quota story.
- **FILE / CREDENTIALS / RUN parameter values in `triggerBuild`.** `multipart/form-data` uploads and `CredentialsParameterValue` payloads are an order of magnitude more code than the multi-value fix. Keep on the roadmap; ship only the multi-value fix in v1.2.
- **Global `format: "text" | "json"` flag.** Narrow win, broad surface change. Skip until two real consumers ask for it.

## 4. Architecture / cross-cutting concerns

### 4.1 Shared `ParameterSpec` type

A single canonical Zod discriminated union, exported from a new file `src/schemas/parameter.ts`, used by `getJobParameters` (the read API) and `describeJob` (the structured-config read API). Future write-side tools (deferred to v1.3) will reuse the same type.

```ts
export const parameterSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"),  name: z.string(), default: z.string().optional(), description: z.string().optional(), trim: z.boolean().optional() }),
  z.object({ type: z.literal("text"),    name: z.string(), default: z.string().optional(), description: z.string().optional() }),
  z.object({ type: z.literal("boolean"), name: z.string(), default: z.boolean().optional(), description: z.string().optional() }),
  z.object({ type: z.literal("choice"),  name: z.string(), choices: z.array(z.string()), default: z.string().optional(), description: z.string().optional() }),
  z.object({ type: z.literal("password"),name: z.string(), description: z.string().optional() }), // no default exposure
  z.object({ type: z.literal("file"),    name: z.string(), description: z.string().optional() }),
  z.object({ type: z.literal("run"),     name: z.string(), projectName: z.string().optional(), description: z.string().optional() }),
  z.object({ type: z.literal("credentials"), name: z.string(), credentialType: z.string().optional(), description: z.string().optional() }),
  z.object({ type: z.literal("unknown"), name: z.string(), rawType: z.string(), description: z.string().optional() }),
]);
export type ParameterSpec = z.infer<typeof parameterSpec>;
```

The `unknown` branch is the honest escape hatch for exotic plugins (ExtendedChoiceParameter, NodeParameter, etc.). The model sees `type: "unknown", rawType: "ExtendedChoiceParameterDefinition"` and knows it has to fall back to `getJobConfig`.

### 4.2 New dependency: `fast-xml-parser`

Required for `describeJob` (parse a known subset of `config.xml`) and `previewJobConfig` (build XML from a spec). Pin to a stable major (`^4`). No other XML libraries are introduced. We deliberately do **not** parse the entire XML into a typed model — only known XPath-ish locations. Anything else stays untouched and is reported via `unknownXmlElements`.

### 4.3 Backward-compatibility rules

- Existing tool signatures are extended only with **optional** parameters.
- Output format strings (`formatJobDetail`, `formatBuild`, etc.) keep their current shape; new fields are appended, never removed.
- The legacy `Record<string, string>` form of `triggerBuild.parameters` continues to work. Comma-splitting is preserved as a fallback when a value is a plain string — but a new `string[]` value form bypasses splitting entirely. Documentation will recommend arrays for any value that may contain commas.

### 4.4 No new env flags in v1.2

- `JENKINS_ALLOW_UNSAFE_OPERATIONS` is unchanged. None of the v1.2 features write to Jenkins; everything ships unconditionally.
- `JENKINS_ENABLE_HEAVY_SCANS` was discussed for findStuck/findFlaky tools — those are deferred, so the flag is not introduced now.

## 5. Features

### 5.1 Fix multi-value parameter loss in `triggerBuild`

**Problem.** `builds.ts:29` does `value.split(",")` on every parameter value, then submits each piece as a separate occurrence. A value like `"description with, embedded commas"` becomes `["description with", "embedded commas"]` — silent data corruption. There is no escape hatch.

**Change.** Accept either `string` or `string[]` per parameter:
```ts
parameters: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
```
- `string[]` → submitted as multi-value (one form-data field per element, plus the corresponding `parameter[]` JSON entry). No splitting.
- `string` → submitted as a single value, **no comma splitting**. (Breaking? See note below.)
- Empty strings are passed through as-is (Jenkins accepts them).

**Backward-compatibility note.** The current implementation splits comma-bearing strings into multi-value submissions for `ExtendedChoiceParameter (PT_CHECKBOX)`. That behaviour is buggy by intent — it conflates "this is one string with commas" with "this is several values". Removing it is technically a behaviour change. We mitigate by:
1. Updating the tool description to instruct callers to use `string[]` for multi-value parameters.
2. Adding an explicit `splitOnComma?: boolean` opt-in (default `false`) for callers that depended on the old behaviour. Marked deprecated in the description; remove in v2.0.

**Files**: `src/tools/builds.ts` (the `triggerBuild` handler).

**Tests**: a value containing a literal comma round-trips as a single value; a `string[]` round-trips as N values; the legacy `splitOnComma: true` reproduces today's behaviour.

**Size**: XS (≈ 30 lines).

---

### 5.2 `getBuild` returns build parameters

**Problem.** Today's tree request (`builds.ts:76`) pulls `actions[causes[...]]` and `artifacts` and `changeSets` but not `actions[parameters[name,value]]`. The model cannot answer "what parameters did this build run with?" without scraping HTML or running a separate API call we don't expose.

**Change.**
1. Add `actions[parameters[name,value]]` to the tree query.
2. Surface a `parameters` block in `formatBuild` output and (later) in any JSON variant. For sensitive-parameter values (PASSWORD type) Jenkins already returns `{name, value: ""}` — display as `[hidden]`.
3. Optional `include?: ("artifacts"|"changes"|"causes"|"parameters")[]` on the tool input. Default = `["causes", "parameters"]`. Adding `"artifacts"` or `"changes"` opts in to the heavier fields. Omitting `include` entirely keeps the current default-rich behaviour to avoid silently dropping data for existing callers.

**Files**: `src/tools/builds.ts`, `src/utils/formatters.ts`, `src/types.ts`.

**Tests**: `getBuild` on a parameterised job returns its parameter values; `include: ["causes"]` omits artifacts/changes; PASSWORD parameters are masked.

**Size**: S (≈ 60 lines including formatter).

---

### 5.3 `getQueueItem(queueId)`

**Problem.** `triggerBuild` returns `queue/item/123` in its success message but no tool consumes that ID. Once Jenkins promotes the item to a running build, it disappears from `getQueue` (which only lists pending) and there's no programmatic queue→build mapping.

**Change.** New tool calling `GET /queue/item/{id}/api/json`:
```ts
register("getQueueItem",
  "Get the state of a specific queue item by ID. Use the queue ID returned from triggerBuild to find which build was started.",
  z.object({
    queueId: z.number().int().describe("Queue item ID (the number returned by triggerBuild as 'Queue item: #N')"),
  }),
  async ({queueId}) => { /* GET /queue/item/{id}/api/json */ }
);
```

Output (text):
```
Queue item #123: LEFT_QUEUE
Build started: my-folder/my-job#42
URL: https://jenkins.example.com/job/my-folder/job/my-job/42/
```
or
```
Queue item #123: WAITING
Why: Waiting for next available executor on 'agent-1'
```
or
```
Queue item #123: CANCELLED
```

The Jenkins API returns one of `WaitingItem`, `BlockedItem`, `BuildableItem`, `LeftItem` (with `executable.number`/`executable.url`), or `CancelledItem`. We map these to `WAITING`, `BLOCKED`, `BUILDABLE`, `LEFT_QUEUE`, `CANCELLED` and include the relevant fields.

**Files**: new section in `src/tools/discovery.ts` (or a new `src/tools/queue.ts` if discovery grows). Probably keep in `discovery.ts` next to `getQueue`.

**Tests**: queue-item that has not yet started returns `WAITING` plus `why`; an item that has started returns `LEFT_QUEUE` plus `{number, url}`; a cancelled item returns `CANCELLED`.

**Size**: S (≈ 40 lines).

---

### 5.4 `getJobParameters(jobPath)` — structured parameter schema

**Problem.** `getJob` returns parameter definitions formatted as plain text (`formatters.ts:87-94`) and the current tree query (`jobs.ts:51`) does not even fetch `choices`, `numChoices`, `passwordParameterDefinition`, etc. The model has to guess at types and valid values.

**Change.** New tool returning `{ parameters: ParameterSpec[] }` (see §4.1) for any job that defines parameters.

Implementation:
1. Tree request `?tree=property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices,multiSelectDelimiter,passwordParameterDefinition,credentialType,projectName]]` — pulls everything Jenkins exposes via JSON.
2. Map each `ParameterDefinition._class` to the corresponding `ParameterSpec` branch. Unknown classes → `{type: "unknown", rawType: <class>, name, description}`.
3. For exotic types where `api/json` doesn't return choices but `config.xml` does (this is the case with some plugin-defined parameters), do **not** auto-fall-back to fetching `config.xml` in v1.2 — return `unknown` with a clear note in the description. Auto-fallback can be a v1.3 enhancement; we want to keep this tool to one HTTP call.

Output is JSON inside the text content (since MCP transport is text-only). Pretty-printed for readability.

**Files**: `src/schemas/parameter.ts` (new), `src/tools/jobs.ts` (new tool registration).

**Tests**: choice/string/boolean/password parameters round-trip into the right `type`; an unknown parameter class becomes `{type: "unknown"}` rather than failing; the tool returns `{parameters: []}` for a job with no parameters.

**Size**: S (≈ 80 lines including the schema file).

---

### 5.5 `describeJob(jobPath)` — structured config read

**Problem.** Reading `config.xml` and parsing by hand is the current escape hatch for any structural question about a job. The model can do it, but every conversation pays the same cost.

**Change.** New tool that downloads `config.xml`, parses with `fast-xml-parser`, and returns a typed subset:

```ts
{
  jobPath: string,
  type: "pipeline" | "multibranch" | "folder" | "freestyle" | "unknown",
  description?: string,
  disabled: boolean,
  concurrentBuilds: boolean,
  scm?: {
    type: "git" | "unknown",
    url?: string,
    branches?: string[],
    credentialsId?: string,
    jenkinsfilePath?: string,         // pipeline only
  },
  triggers?: {
    cron?: string,
    scmPolling?: string,
  },
  parameters?: ParameterSpec[],         // reuses §4.1
  buildRetention?: {
    numToKeep?: number,
    daysToKeep?: number,
  },
  unknownXmlElements: string[],         // top-level XML element names we did not parse
}
```

**Scope of parsing.**
- v1.2 covers **`flow-definition` (single-branch Pipeline)**, **`org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject`**, and **`com.cloudbees.hudson.plugins.folder.Folder`** root elements.
- `freestyle` (`project`) is recognised but only `description`, `disabled`, `concurrentBuild`, `parameters`, and `buildRetention` are parsed. Everything else — including `scm` (which can be Git/SVN/Mercurial with different XML shapes) — is reported via `unknownXmlElements`.
- Anything else → `type: "unknown"` plus the raw config available through the existing `getJobConfig`.

**Honest limitations** (called out in the tool description):
- Plugin-specific SCM sources beyond Git (GitLabSCMSource, GitHubSCMSource) are recognised by element name but only their `serverUrl`/`repoOwner`/`repository` get extracted. Branch include/exclude regexes are skipped in v1.2.
- We do not parse build-step graphs in freestyle jobs.

**Files**: `src/tools/jobs.ts` (new tool), `src/utils/job-xml.ts` (new — XPath-style readers, shared with §5.6).

**Tests**: a single-branch pipeline returns `type: "pipeline"`, `scm.url`, `scm.branches`, `scm.jenkinsfilePath`; a multibranch returns `type: "multibranch"` with one of the recognised SCM sources; a freestyle reports `type: "freestyle"` with `unknownXmlElements` containing `scm`/`builders`/`publishers`; a job with a custom plugin element gets `type: "unknown"` plus a note.

**Size**: M (≈ 250 lines including parser helpers and fixtures).

---

### 5.6 `previewJobConfig(spec)` — local XML codegen + diff

**Problem.** Even with `JENKINS_ALLOW_UNSAFE_OPERATIONS=true` enabled, building correct `config.xml` by hand is error-prone — XML escaping, plugin element classes, attribute order, etc. Today the workaround is "ask the model to write XML and pray".

**Change.** New **safe** tool (always registered, no unsafe gate). Takes the same structured spec shape `describeJob` returns (or a subset for create-mode), generates the XML via `fast-xml-parser` build mode, and optionally diffs against an existing config.

```ts
register("previewJobConfig",
  "Generate a Jenkins job XML config from a structured spec. Optionally diff it against an existing job's current config. Read-only - does not modify Jenkins.",
  z.object({
    spec: jobSpecSchema,                             // pipeline | multibranch | folder
    diffAgainstJobPath: z.string().optional(),       // if set, fetch and diff
  }),
  async (args) => { /* ... */ }
);
```

`jobSpecSchema` covers the same three project types as `describeJob`'s parser:
- `pipeline` (with `scm` + `jenkinsfilePath` + `parameters` + `triggers` + `buildRetention`)
- `multibranch` (with `source` + `jenkinsfilePath` + `orphanedItemStrategy`)
- `folder` (description only)

Output:
```
=== Generated config.xml (pipeline) ===
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  ...
</flow-definition>

=== Diff against my-folder/my-job ===
@@ scm.branches @@
- main
+ release/2.0
@@ buildRetention.numToKeep @@
- 10
+ 50
```

Diff is computed as a **structured field-level diff** between the input spec and the output of `describeJob` on the existing job (so we diff structured subsets, not raw XML — much more readable). For unknown XML elements we emit a single `(skipped: <element-name>)` line rather than trying to diff sub-trees.

**Files**: `src/tools/jobs.ts` (new tool), `src/utils/job-xml.ts` (build helpers reused from §5.5), `src/utils/job-diff.ts` (new — structured diff).

**Tests**: pipeline spec → XML that round-trips through the v1.2 `getJobConfig` parser; multibranch spec same; diff between two pipeline specs surfaces only changed fields; spec validation rejects required fields missing.

**Size**: M (≈ 300 lines).

---

### 5.7 `getBuildLog` extension: in-tool grep with context

**Problem.** Logs in Jenkins are usually small to mid-sized (≈ 1–10 MB). The model frequently knows what it's looking for ("the line with `BUILD FAILED`") but the existing tool only gives a tail or a byte slice. Multi-round-tripping for a single grep is expensive.

**Change.** Add optional grep-mode parameters to the existing `getBuildLog`:

```ts
z.object({
  jobPath: z.string(),
  buildNumber: z.number().optional(),
  maxLines: z.number().optional().default(200),     // unchanged
  startByte: z.number().optional(),                 // unchanged
  // NEW:
  pattern: z.string().optional().describe("Search pattern. If provided, switches to grep mode."),
  regex: z.boolean().optional().default(false).describe("Treat pattern as regex (default: substring, case-insensitive)"),
  before: z.number().optional().default(0).describe("Lines of context before each match"),
  after: z.number().optional().default(0).describe("Lines of context after each match"),
  maxMatches: z.number().optional().default(50).describe("Stop after this many matches"),
})
```

Behaviour:
- If `pattern` is **not** set, behaviour is unchanged (tail or byteStart).
- If `pattern` **is** set:
  - `startByte`/`maxLines` are ignored (with a note in the description).
  - We fetch `consoleText` once, iterate line-by-line, accumulate matches with `before`/`after` context, stop early after `maxMatches`.
  - Output is a sequence of numbered match blocks with `===` separators and explicit line numbers, matching the format users get from `grep -n -B X -A Y`.
- Regex compilation errors are caught and returned as `Error: Invalid regex: <message>` — never crash.

Output sample:
```
--- Build Log Search: pattern="ERROR" (regex=false, before=2, after=3) ---
Total matches: 4 (showing 4 of 4)

=== match #1 (line 1487) ===
1485:   added 234 packages
1486: 
1487: ERROR: Failed to compile
1488:   TypeError: Cannot read property 'foo' of undefined
1489:     at /workspace/src/index.ts:42
1490: 

=== match #2 (line 2103) ===
...
```

**Files**: `src/tools/builds.ts`.

**Tests**: substring grep returns N matches with context; regex mode handles `\bERROR\b`; `maxMatches` truncates and reports the truncation; invalid regex returns a clean error; absence of `pattern` preserves the legacy tail behaviour exactly.

**Size**: S (≈ 80 lines).

---

### 5.8 `searchBuildLogs` v2: regex, context, result filter, ranged read

**Problem.** Today's tool downloads the **entire** `consoleText` for each searched build (`discovery.ts:117`), substring-greps in JS, and returns 200-char-truncated lines without context. On a 50 MB log this is 50 MB of bandwidth per build, times `lastN`.

**Change.** Extend `searchBuildLogs` (additive — no removed parameters):

```ts
z.object({
  jobPath: z.string(),
  pattern: z.string(),
  buildNumber: z.number().optional(),
  lastN: z.number().optional().default(5),
  // NEW:
  regex: z.boolean().optional().default(false),
  before: z.number().optional().default(0),
  after: z.number().optional().default(0),
  maxMatchesPerBuild: z.number().optional().default(10),
  onlyResults: z.array(z.enum(["SUCCESS","FAILURE","UNSTABLE","ABORTED","NOT_BUILT"])).optional()
    .describe("Filter builds by result before searching. Default: search all."),
})
```

Behaviour:
- `onlyResults` pre-filter — if set, fetch `builds[number,result]{0,N}` and skip builds whose result isn't in the filter. Common case `["FAILURE","UNSTABLE","ABORTED"]` skips half the work on healthy jobs.
- Regex mode and context lines mirror §5.7.
- `maxMatchesPerBuild` stops scanning a single log once N matches are found.

**Read strategy** (the streaming optimisation observability-lead pushed for):
- Try `GET /{build}/logText/progressiveText?start=0` first. The response body is a chunk and the `X-Text-Size` header gives the total size; `X-More-Data` indicates whether to continue. If `X-More-Data: true` we loop with `start=<X-Text-Size>` until done.
- This lets us **stream** the log in (default) 1 MB chunks, run the matcher per chunk, and abort once `maxMatchesPerBuild` is satisfied. No need for HTTP `Range:` (which Jenkins does not reliably support on `consoleText`).
- Fallback: if `progressiveText` returns 404 or the size header is missing, drop to the existing `consoleText` full-fetch.

**Files**: `src/tools/discovery.ts` (the existing `searchBuildLogs` plus a new `streamBuildLog` helper); `src/jenkins-client.ts` (new method `getRangedText` reading `progressiveText` and yielding chunks).

**Tests**: regex pattern with context returns expected blocks; `onlyResults: ["FAILURE"]` skips green builds; `maxMatchesPerBuild` truncates and reports it; progressive read stops early when matches are satisfied (verified via mocked client tracking byte count); fallback to full fetch when `progressiveText` is unavailable.

**Size**: M (≈ 200 lines including the streaming helper).

---

## 6. Safety review

None of v1.2's tools are write-side. Concretely:
- `triggerBuild` mutation surface is unchanged (still posts to `/build` or `/buildWithParameters`); the change is purely how we serialise the values we already accepted.
- `getBuild`, `getQueueItem`, `getJobParameters`, `describeJob`, `getBuildLog`, `searchBuildLogs` are all reads.
- `previewJobConfig` is local-only — it can fetch `config.xml` for diff, but never POSTs.

So `JENKINS_ALLOW_UNSAFE_OPERATIONS` is unchanged. The existing unsafe set (`replayBuild`, `updateJobConfig`) remains gated as today. No new flags introduced.

## 7. Risks & open questions

- **`splitOnComma` legacy escape hatch (§5.1).** We're keeping it for one minor cycle and removing in v2.0. If it turns out users have hard-coded comma-separated values in long-lived prompts, the deprecation warning in the tool description may not be enough. Mitigation: include a clear migration note in the v1.2 release notes.
- **`describeJob` SCM coverage (§5.5).** Only Git is fully parsed. GitLab/GitHub source plugins get partial recognition. Freestyle SCM is left as raw. We accept this — the tool description must say so loudly.
- **`previewJobConfig` round-trip fidelity (§5.6).** XML generated for an existing job won't byte-equal the original `config.xml` (whitespace, attribute order, comments). The diff is structured, not textual, so this is fine for the spec as written. Worth flagging in docs so nobody is surprised.
- **`progressiveText` chunk size (§5.8).** Default 1 MB is a guess. We may need to tune based on a real Jenkins's response size. Configurable via an internal constant; not exposed as a tool parameter.
- **Versioning.** All changes are backward-compatible; semver minor bump (1.1.0 or 1.2.0). I propose **1.2.0** to leave 1.1.x as the current state and signal a meaningful feature wave. The CI release job picks the bump from conventional-commit prefixes — shipping these as `feat:` commits will land us on 1.2.0 automatically.

## 8. Acceptance criteria

A v1.2 release is acceptable when:

1. **Testing strategy.** The repo currently has no automated test suite. Two options, decided during planning:
   - **Option A (lighter):** ship v1.2 without adding a test framework; verify each new tool against a real Jenkins instance and record the verification log in the PR description.
   - **Option B (heavier):** introduce Vitest in this release; require golden-path + one error-path tests per new tool; mock `fetch` against the existing `JenkinsClient`.
   Pick during the implementation-plan phase. Default recommendation: Option A for v1.2, switch to Option B in v1.3 when we add write-side tools that demand tighter regression coverage.
2. `npm run lint` and `npm run build` pass with zero warnings.
3. The eight features in §5 are implemented behind no new env flags.
4. The README is updated with the new tool list and the multi-value migration note.
5. CI auto-publishes 1.2.0 to npm via the existing release job.

## 9. Rollout order

The features have only one cross-dependency: §5.5 and §5.6 share `src/utils/job-xml.ts`. Suggested implementation order:

1. **§4.1** (`ParameterSpec` schema file) — pure refactor, no behaviour change.
2. **§5.1** (`triggerBuild` multi-value fix) — small, ships a real bug fix immediately.
3. **§5.2** (`getBuild` parameters) — trivial tree change, unblocks debugging flows.
4. **§5.3** (`getQueueItem`) — tiny new tool, closes the queue→build hole.
5. **§5.4** (`getJobParameters`) — new tool using §4.1.
6. **§5.7** (`getBuildLog` grep) — extends an existing tool.
7. **§5.8** (`searchBuildLogs` v2) — extends + adds streaming helper.
8. **§5.5** (`describeJob`) — first XML-parsing tool; introduces `fast-xml-parser`.
9. **§5.6** (`previewJobConfig`) — depends on §5.5's parser helpers.

Steps 1–7 are independent and can be parallelised across PRs; 8 must precede 9.

---

## Appendix A: tool count after v1.2

Current: 16 default + 2 unsafe = 18. After v1.2:
- New tools: `getQueueItem`, `getJobParameters`, `describeJob`, `previewJobConfig` (+4)
- Extended tools: `triggerBuild`, `getBuild`, `getBuildLog`, `searchBuildLogs`
- Unchanged: 12

Total: 20 default + 2 unsafe = 22.
