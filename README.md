# Jenkins MCP Server

A custom MCP (Model Context Protocol) server for Jenkins integration with Claude Code. Provides 18 tools for comprehensive Jenkins management including pipeline replay, stage-level logs, job configuration editing, and multibranch pipeline support.

## Why?

The official Jenkins MCP plugin has timeout issues (30s timeouts). This standalone server connects directly to Jenkins REST API and works reliably.

## Installation

```bash
npm install
npm run build
```

## Configuration

### Claude Code

Add to your `.claude/settings.json`:

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "node",
      "args": ["/path/to/jenkins-mcp/dist/index.js"],
      "env": {
        "JENKINS_URL": "https://your-jenkins.example.com",
        "JENKINS_USER": "your-username",
        "JENKINS_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JENKINS_URL` | Yes | Jenkins server URL |
| `JENKINS_USER` | Yes | Jenkins username |
| `JENKINS_API_TOKEN` | Yes | Jenkins API token (User > Configure > API Token) |

## Tools (18)

### Job Management
- **getJobs** — List jobs in a folder with status
- **getJob** — Job details, parameters, health, branches
- **getJobConfig** — Get job XML configuration (config.xml)
- **updateJobConfig** — Update job XML configuration

### Build Operations
- **triggerBuild** — Trigger builds with optional parameters
- **getBuild** — Build details (status, duration, changes)
- **getBuildLog** — Console output with tail/pagination
- **stopBuild** — Abort a running build
- **getBuildArtifacts** — List build artifacts
- **getBuildTestResults** — Test results with failure details

### Pipeline
- **getPipelineStages** — Stage overview (names, status, duration)
- **getStageLog** — Log for a specific pipeline stage
- **getPipelineScript** — Get Jenkinsfile from replay page
- **replayBuild** — Replay build with optional script changes
- **restartFromStage** — Restart pipeline from a specific stage

### Discovery
- **searchBuildLogs** — Search logs across recent builds
- **getQueue** — View the build queue
- **enableDisableJob** — Enable or disable a job

## Multibranch Pipelines

Job paths use `/` as separator: `folder/pipeline/branch`

For branches with slashes in the name, use `::` separator:
```
my-pipeline::feature/my-branch
```

## Notes

- **Replay** uses Jenkins' form-based replay endpoint (not a clean REST API)
- **Restart from Stage** requires the Declarative Pipeline plugin
- **Config editing** works with raw XML — use getJobConfig to read, modify, then updateJobConfig
- Build logs are capped at 100KB per response; use pagination for larger logs
- CSRF crumbs are handled automatically
