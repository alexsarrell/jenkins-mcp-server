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

## License

MIT
