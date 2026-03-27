# @alexsarrell/jenkins-mcp-server

A custom MCP (Model Context Protocol) server for Jenkins integration with Claude Code. Provides 18 tools for comprehensive Jenkins management including pipeline replay, stage-level logs, job configuration editing, and multibranch pipeline support.

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

## Tools (18)

### Job Management
- **getJobs** - List jobs in a folder with status summary
- **getJob** - Job details, parameters, health, branches (for multibranch pipelines)
- **getJobConfig** - Get job XML configuration (config.xml)
- **updateJobConfig** - Update job XML configuration

### Build Operations
- **triggerBuild** - Trigger builds with optional parameters (supports parameterized builds)
- **getBuild** - Build details (status, duration, changes)
- **getBuildLog** - Console output with tail/pagination support
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
- **searchBuildLogs** - Grep across build logs for a pattern
- **getQueue** - View the build queue
- **enableDisableJob** - Enable or disable a job

## Multibranch Pipelines

Job paths use `/` as separator: `folder/pipeline/branch`

For branches with slashes in the name, use `::` separator:
```
my-pipeline::feature/my-branch
```

## Notes

- **Replay** uses Jenkins' form-based replay endpoint (not a clean REST API)
- **Restart from Stage** requires the Declarative Pipeline plugin
- **Config editing** works with raw XML - use `getJobConfig` to read, modify, then `updateJobConfig`
- Build logs are capped at 100KB per response; use pagination for larger logs
- CSRF crumbs are handled automatically
- Authentication uses HTTP Basic Auth with user API token

## License

MIT
