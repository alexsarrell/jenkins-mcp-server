# @alexsarrell/jenkins-mcp-server v1.3.0

A custom MCP (Model Context Protocol) server for Jenkins integration with Claude Code. Provides 22 tools (20 default + 2 unsafe) for comprehensive Jenkins management including pipeline replay, stage-level logs, structured config reads, parameter introspection, and rich log search.

## Why?

The official Jenkins MCP plugin has timeout issues (30s timeouts). This standalone server connects directly to Jenkins REST API via stdio transport and works reliably.

## Quick Start

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "jenkins": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@alexsarrell/jenkins-mcp-server"],
      "env": {
        "JENKINS_URL": "https://your-jenkins.example.com",
        "JENKINS_USER": "your-username",
        "JENKINS_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Restart Claude Code and the `jenkins` MCP server will be available.

### Getting Your API Token

1. Log in to Jenkins
2. Click your username (top right) -> Configure
3. API Token -> Add new Token -> Generate
4. Copy the token

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JENKINS_URL` | Yes | Jenkins server URL |
| `JENKINS_USER` | Yes | Jenkins username |
| `JENKINS_API_TOKEN` | Yes | Jenkins API token |
| `JENKINS_ALLOW_UNSAFE_OPERATIONS` | No | Set to `true` to enable unsafe tools (`replayBuild`, `updateJobConfig`) |

### Unsafe Operations

By default, tools that can execute arbitrary code or modify job configurations are **disabled**. This includes:

- **replayBuild** — replays a build with arbitrary Groovy/Pipeline script
- **updateJobConfig** — overwrites job XML configuration

To enable them, add the env variable to your MCP config:

```json
"env": {
  "JENKINS_URL": "...",
  "JENKINS_USER": "...",
  "JENKINS_API_TOKEN": "...",
  "JENKINS_ALLOW_UNSAFE_OPERATIONS": "true"
}
```

## Tools (20 default + 2 unsafe)

### Job Management
- **getJobs** - List jobs in a folder with status summary
- **getJob** - Job details, parameters, health, branches (for multibranch pipelines)
- **getJobConfig** - Get job XML configuration (config.xml)
- **getJobParameters** - Structured `ParameterSpec[]` for the job (types, choices, defaults). Use this before `triggerBuild` to know what to pass.
- **describeJob** - Structured read of `config.xml` (SCM url/branch, Jenkinsfile path, parameters, cron, retention) without parsing raw XML.
- **previewJobConfig** - Generate a `config.xml` from a structured spec (pipeline / multibranch / folder), optionally diffed against an existing job. Read-only.
- **updateJobConfig** - Update job XML configuration

### Build Operations
- **triggerBuild** - Trigger builds with optional parameters (string or string[] values for multi-value parameters)
- **getBuild** - Build details (status, duration, parameters, artifacts, changes); use `include` to control returned sections
- **getBuildLog** - Console output with tail / byte-pagination / grep modes (regex + before/after context)
- **stopBuild** - Abort a running build
- **getBuildArtifacts** - List build artifacts
- **getBuildTestResults** - Test results with failure details

### Pipeline
- **getPipelineStages** - Stage overview (names, status, duration)
- **getStageLog** - Log for a specific pipeline stage
- **getPipelineScript** - Get Jenkinsfile content from replay page
- **replayBuild** - Replay a build with optional script modifications
- **restartFromStage** - Restart pipeline from a specific stage

### Discovery & Utilities
- **searchBuildLogs** - Grep across build logs (regex, before/after context, `onlyResults` filter, progressive read)
- **getQueue** - View the build queue
- **getQueueItem** - Map a queue item ID (returned by `triggerBuild`) to the build that started, or its current waiting/cancelled state
- **enableDisableJob** - Enable or disable a job

## Multibranch Pipelines

Job paths use `/` as separator: `folder/pipeline/branch`

For branches with slashes in the name, use `::` separator:
```
my-pipeline::feature/my-branch
```

## Multi-value parameters

`triggerBuild` accepts each parameter value as either a string or a string array. The string form is **never** split on commas — passing `"hello, world"` sends one value verbatim. For multi-select / `ExtendedChoiceParameter (PT_CHECKBOX)` parameters, pass an array:

```js
triggerBuild({ jobPath: "x", parameters: { TAGS: ["alpha", "beta", "gamma"] } });
```

A legacy `splitOnComma: true` flag preserves the pre-1.3 behaviour (split string values on commas) — deprecated, will be removed in v2.0.

## Log search and grep

Both `getBuildLog` and `searchBuildLogs` accept a `pattern` (with optional `regex`) and `before`/`after` context lines. `getBuildLog` switches to grep mode when `pattern` is set; otherwise it returns a tail. `searchBuildLogs` streams logs via Jenkins' progressive-text API and stops early once `maxMatchesPerBuild` is reached, and an `onlyResults: ["FAILURE"]` filter prunes builds before fetching their logs.

## Notes

- **Replay** uses Jenkins' form-based replay endpoint (not a clean REST API)
- **Restart from Stage** requires the Declarative Pipeline plugin
- **Config editing** works with raw XML — use `getJobConfig` (or `describeJob` for a structured subset) to read, modify, then `updateJobConfig`. For new configs from a spec, use `previewJobConfig` then paste into `updateJobConfig`.
- Build logs are capped at 100KB per response; use grep mode or pagination for larger logs
- CSRF crumbs are handled automatically
- Authentication uses HTTP Basic Auth with user API token

## What's new in v1.3

Backward-compatible feature wave focused on parameter UX, queue→build observability, structured config reads, and richer log search. All existing tools keep their old contract; new fields are optional.

### New tools (4)

- **`getJobParameters(jobPath)`** — returns a structured `ParameterSpec[]` for the job. Each parameter is tagged with `type` (`string` / `text` / `boolean` / `choice` / `password` / `file` / `run` / `credentials` / `unknown`) and carries `default`, `choices`, `description`, etc. as appropriate. Use this before `triggerBuild` so the model picks valid values instead of guessing. Exotic plugin types fall back to `{type: "unknown", rawType: "<FQCN>"}` honestly rather than misclassifying.

- **`getQueueItem(queueId)`** — bridges the queue → build gap. `triggerBuild` returns a `Queue item: #N` URL; previously you couldn't tell which build (if any) actually started. Now `getQueueItem(N)` returns one of `WAITING` / `BLOCKED` / `BUILDABLE` / `LEFT_QUEUE` (with build number + URL) / `CANCELLED` / `UNKNOWN`. Foundation for any future `triggerAndWait`-style composite.

- **`describeJob(jobPath)`** — structured read of `config.xml` without parsing raw XML. Returns SCM url/branch/credentialsId/Jenkinsfile path, parameters, cron trigger, build retention, plus a `unknownXmlElements: string[]` listing every top-level element we did NOT parse (so callers know when to fall back to `getJobConfig`). Also returns `rawConfigSha` (12-char SHA-256 prefix) for future optimistic concurrency. Coverage: single-branch Pipeline + Git SCM, Multibranch + GitSCMSource, Folder, partial Freestyle.

- **`previewJobConfig({spec, diffAgainstJobPath?})`** — generates Jenkins XML from a structured spec (pipeline / multibranch / folder) plus an optional structured diff against an existing job. Read-only — does not modify Jenkins. Lets you assemble correct XML through a typed interface, then paste into `updateJobConfig` if `JENKINS_ALLOW_UNSAFE_OPERATIONS=true`. XML escaping is handled automatically by the builder.

### Extended tools (4)

- **`triggerBuild`** — fixes a silent-data-loss bug: `value.split(",")` no longer mangles parameter values containing commas. `parameters` now accepts `Record<string, string | string[]>`; arrays are submitted as multi-value (for `ExtendedChoiceParameter (PT_CHECKBOX)` and similar). Legacy `splitOnComma: true` opt-in preserves pre-1.3 behaviour, deprecated for v2.0.

- **`getBuild`** — now returns build parameters in its `Parameters (N):` block (password values masked as `[hidden]`). New optional `include: ("artifacts"|"changes"|"causes"|"parameters")[]` controls which sections to fetch — default keeps the old fields and adds parameters. Closes the "with what params did this build run?" blind spot.

- **`getBuildLog`** — gains a third mode (grep) on top of tail and byte-pagination. New optional `pattern` switches the tool to grep mode, with `regex`, `before`, `after`, `maxMatches` for context control. Output mirrors `grep -n -B X -A Y` with padded line numbers and `=== match #N ===` separators. Tail and pagination behaviours are unchanged when `pattern` is absent.

- **`searchBuildLogs` v2** — regex / context / `onlyResults` filter / progressive streaming. Streams console text via Jenkins' `/logText/progressiveText` chunk-by-chunk and stops early once `maxMatchesPerBuild` is reached, so it doesn't download an entire 50 MB log to find the first error. `onlyResults: ["FAILURE"]` skips green builds before fetching their logs. Falls back to `/consoleText` if progressive streaming is unavailable.

### Infrastructure

- **Vitest test runner** — pure-function logic now has unit-test coverage (47 tests). `npm test`, `npm run test:watch`. Added to GitLab CI in the `check` stage.
- **`fast-xml-parser` runtime dependency** — used by `describeJob` (parse) and `previewJobConfig` (build). Pinned to `^4.5.6`.
- **MCP server version is now read from `package.json`** at startup, so the version in the MCP handshake stays in sync with the published npm version automatically.

### Explicitly deferred to v1.4+

`patchJobConfig`, `createPipelineJob`, `copyJob` (job-config writes), observability composites (`getFailureSummary`, `compareBuilds`, `getJobTrends`, `getNodes`, `getTestStability`), heavy scans (`findStuckBuilds`, `findFlakyJobs`), FILE/CREDENTIALS values in `triggerBuild`, and a global `format: json` flag. See [docs/superpowers/specs/2026-04-29-jenkins-mcp-v2-design.md](docs/superpowers/specs/2026-04-29-jenkins-mcp-v2-design.md) §3 Non-goals for the rationale on each.

## License

MIT
