# Jenkins MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Jenkins MCP server that provides 18 tools for full Jenkins integration with Claude Code, replacing the broken official plugin.

**Architecture:** TypeScript MCP server using `@modelcontextprotocol/sdk` over stdio transport. Connects to Jenkins via REST API with Basic Auth (user + API token). Handles CSRF crumbs automatically. Supports multibranch pipelines with transparent path resolution.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`, native `fetch` for HTTP

---

## File Structure

```
jenkins-mcp/
├── package.json              # Package config, bin entry, dependencies
├── tsconfig.json             # TypeScript config
├── src/
│   ├── index.ts              # Entry point: MCP server setup, tool registration
│   ├── jenkins-client.ts     # Jenkins REST API client (auth, crumb, requests)
│   ├── tools/
│   │   ├── jobs.ts           # list_jobs, get_job, get/update_job_config, enable_disable
│   │   ├── builds.ts         # trigger, get_build, get_log, stop, artifacts, test_results
│   │   ├── pipeline.ts       # stages, stage_log, get_script, replay, restart_from_stage
│   │   └── discovery.ts      # search_logs, get_queue
│   ├── utils/
│   │   ├── path-resolver.ts  # jobPath -> Jenkins URL, multibranch detection, encoding
│   │   └── formatters.ts     # Response text formatting for LLM
│   └── types.ts              # Shared TypeScript types
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "jenkins-mcp-server",
  "version": "1.0.0",
  "description": "Jenkins MCP server for Claude Code integration",
  "main": "dist/index.js",
  "bin": {
    "jenkins-mcp-server": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js"
  },
  "type": "module",
  "files": ["dist"],
  "keywords": ["jenkins", "mcp", "claude"],
  "license": "MIT"
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install @modelcontextprotocol/sdk zod`
Run: `npm install -D typescript @types/node`

- [ ] **Step 4: Commit**

```bash
git init && git add -A && git commit -m "chore: scaffold jenkins-mcp-server project"
```

---

### Task 2: Jenkins API Client

**Files:**
- Create: `src/types.ts`
- Create: `src/jenkins-client.ts`

- [ ] **Step 1: Create types.ts with shared types**

Core types: `JenkinsConfig`, `JenkinsJob`, `JenkinsBuild`, `PipelineStage`, `BuildArtifact`, `TestResult`, `QueueItem`. Keep minimal — only what we actually use.

- [ ] **Step 2: Create jenkins-client.ts**

`JenkinsClient` class:
- Constructor takes `url`, `user`, `token` from env vars
- `get(path, params?)` — GET with Basic Auth, returns parsed JSON
- `getRaw(path)` — GET returning raw text (for logs, config.xml)
- `post(path, body?, contentType?)` — POST with Basic Auth + CSRF crumb
- `postForm(path, formData)` — POST form data (for replay)
- `fetchCrumb()` — GET `/crumbIssuer/api/json`, cache result, re-fetch on 403
- `buildJobPath(jobPath)` — convert `folder/job` to `/job/folder/job/job/name` URL segments, URL-encode branch names with slashes
- Error handling: parse Jenkins error responses, throw typed errors with `errorCode` field

Key details:
- Crumb cached, refreshed on 403 Forbidden
- All paths auto-prefixed with base URL
- Branch names with `/` encoded as `%2F` in URL path segments
- `tree` query param used internally to minimize response sizes

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add Jenkins REST API client with auth and crumb handling"
```

---

### Task 3: MCP Server Entry Point + Job Tools

**Files:**
- Create: `src/index.ts`
- Create: `src/tools/jobs.ts`
- Create: `src/utils/formatters.ts`

- [ ] **Step 1: Create formatters.ts**

Utility functions:
- `formatJob(job)` — format job info as readable text
- `formatBuild(build)` — format build info
- `truncateResponse(text, maxBytes=100000)` — truncate with message if too large

- [ ] **Step 2: Create tools/jobs.ts with 4 job tools**

Each tool exported as `{ name, description, inputSchema, handler }`:

1. **`getJobs`** — List jobs at root or in folder
   - Params: `folder?` (string), `limit?` (number, default 50)
   - API: `GET /job/{folder}/api/json?tree=jobs[name,url,color,description,lastBuild[number,result,timestamp]]`
   - Returns formatted list with status indicators

2. **`getJob`** — Get job details
   - Params: `jobPath` (string)
   - API: `GET /job/{path}/api/json?tree=...` (name, description, color, buildable, healthReport, lastBuild, property with parameterDefinitions)
   - Returns formatted job info with parameters list

3. **`getJobConfig`** — Get config.xml
   - Params: `jobPath` (string)
   - API: `GET /job/{path}/config.xml`
   - Returns raw XML (truncated if > 100KB)

4. **`updateJobConfig`** — Update config.xml
   - Params: `jobPath` (string), `configXml` (string)
   - API: `POST /job/{path}/config.xml` with XML body
   - Returns success confirmation

- [ ] **Step 3: Create index.ts — MCP server entry point**

- Read `JENKINS_URL`, `JENKINS_USER`, `JENKINS_API_TOKEN` from env
- Validate env vars, exit with clear error if missing
- Create `JenkinsClient` instance
- Create MCP `Server` with `StdioServerTransport`
- Register `tools/list` handler that returns all tool definitions
- Register `tools/call` handler that dispatches to correct tool handler
- Add `#!/usr/bin/env node` shebang

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Compiles without errors, `dist/` created

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add MCP server entry point and job management tools"
```

---

### Task 4: Build Tools

**Files:**
- Create: `src/tools/builds.ts`

- [ ] **Step 1: Create tools/builds.ts with 6 build tools**

5. **`triggerBuild`** — Trigger a build
   - Params: `jobPath` (string), `parameters?` (Record<string, string>)
   - API: POST `/job/{path}/build` or `/job/{path}/buildWithParameters`
   - Returns queue item URL, extract queue ID from `Location` header

6. **`getBuild`** — Get build info
   - Params: `jobPath` (string), `buildNumber?` (number, default: lastBuild)
   - API: `GET /job/{path}/{num}/api/json?tree=...`
   - Returns: number, result, building, duration, timestamp, displayName, description, causes

7. **`getBuildLog`** — Get console output
   - Params: `jobPath` (string), `buildNumber?` (number), `maxLines?` (number, default 200), `fromEnd?` (boolean, default true)
   - API: `GET /job/{path}/{num}/consoleText` then tail/head
   - For progressive: `GET /job/{path}/{num}/logText/progressiveText?start=N`
   - Returns log text + metadata (`hasMore`, `totalSize`, `returnedLines`)

8. **`stopBuild`** — Abort running build
   - Params: `jobPath` (string), `buildNumber` (number)
   - API: `POST /job/{path}/{num}/stop`
   - Returns confirmation

9. **`getBuildArtifacts`** — List artifacts
   - Params: `jobPath` (string), `buildNumber?` (number)
   - API: `GET /job/{path}/{num}/api/json?tree=artifacts[fileName,relativePath]`
   - Returns list with download URLs

10. **`getBuildTestResults`** — Test results
    - Params: `jobPath` (string), `buildNumber?` (number), `onlyFailures?` (boolean, default true)
    - API: `GET /job/{path}/{num}/testReport/api/json`
    - Returns summary (pass/fail/skip counts) + failure details

- [ ] **Step 2: Register build tools in index.ts**

Import and add to tool registry.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add build operation tools (trigger, log, stop, artifacts, tests)"
```

---

### Task 5: Pipeline Tools

**Files:**
- Create: `src/tools/pipeline.ts`

- [ ] **Step 1: Create tools/pipeline.ts with 5 pipeline tools**

11. **`getPipelineStages`** — Get pipeline stages
    - Params: `jobPath` (string), `buildNumber?` (number)
    - API: `GET /job/{path}/{num}/wfapi/describe`
    - Returns: stage list with name, status, durationMillis formatted nicely

12. **`getStageLog`** — Get log for specific stage
    - Params: `jobPath` (string), `buildNumber` (number), `stageName` (string)
    - First: GET wfapi/describe to find stage node ID by name
    - Then: GET `/job/{path}/{num}/execution/node/{nodeId}/wfapi/log`
    - Returns stage log text

13. **`getPipelineScript`** — Get Jenkinsfile from replay page
    - Params: `jobPath` (string), `buildNumber` (number)
    - API: `GET /job/{path}/{num}/replay` — parse HTML to extract script from `<textarea>` elements
    - Returns: mainScript content + list of loaded library scripts

14. **`replayBuild`** — Replay with optional script changes
    - Params: `jobPath` (string), `buildNumber` (number), `mainScript?` (string)
    - If no script provided: fetch current via getPipelineScript internally
    - API: `POST /job/{path}/{num}/replay/run` with form: `mainScript=...&json={"mainScript":"..."}`
    - Requires crumb header
    - Returns: new build URL

15. **`restartFromStage`** — Restart pipeline from stage
    - Params: `jobPath` (string), `buildNumber` (number), `stageName` (string)
    - First: GET wfapi/describe to get stage ID
    - API: Various approaches depending on Jenkins version. Try:
      - `POST /job/{path}/{num}/restart/restart` with `stageName` in body
    - Returns: new build info or error with explanation about plugin requirements

- [ ] **Step 2: Register pipeline tools in index.ts**

- [ ] **Step 3: Build and verify**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add pipeline tools (stages, replay, restart from stage)"
```

---

### Task 6: Discovery Tools + Final Integration

**Files:**
- Create: `src/tools/discovery.ts`

- [ ] **Step 1: Create tools/discovery.ts with 3 tools**

16. **`searchBuildLogs`** — Search logs across builds
    - Params: `jobPath` (string), `pattern` (string), `buildNumber?` (number), `lastN?` (number, default 5)
    - Iterate over last N builds, fetch consoleText, search for pattern
    - Returns: matches with build number, line number, context

17. **`getQueue`** — View build queue
    - API: `GET /queue/api/json?tree=items[id,task[name,url],why,buildableStartMilliseconds,stuck]`
    - Returns formatted queue list

18. **`enableDisableJob`** — Toggle job state
    - Params: `jobPath` (string), `enabled` (boolean)
    - API: `POST /job/{path}/enable` or `POST /job/{path}/disable`
    - Returns confirmation

- [ ] **Step 2: Register discovery tools in index.ts, verify all 18 tools registered**

- [ ] **Step 3: Build and verify final compilation**

Run: `npm run build`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add discovery tools (search logs, queue, enable/disable)"
```

---

### Task 7: Path Resolver Utility

**Files:**
- Create: `src/utils/path-resolver.ts`

- [ ] **Step 1: Create path-resolver.ts**

`resolveJobPath(jobPath: string): string` function:
- Split path by `/`
- For each segment, prepend `/job/` and URL-encode the segment
- Handle special case: branch names with `/` in multibranch pipelines — these come as a single segment like `feature/my-branch` and must be encoded as `feature%2Fmy-branch`
- The user provides paths like `my-folder/my-pipeline/main` meaning folder `my-folder`, pipeline `my-pipeline`, branch `main`
- Return the full URL path segment

This should be extracted from jenkins-client.ts `buildJobPath` method into a standalone utility if not already done during Task 2.

- [ ] **Step 2: Build and verify**

Run: `npm run build`

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: extract path resolver utility for multibranch support"
```

---

### Task 8: End-to-End Verification + Polish

**Files:**
- Modify: `src/index.ts`
- Create: `README.md`

- [ ] **Step 1: Add proper error handling wrapper**

Wrap each tool handler in try/catch that returns `{ isError: true, content: [{ type: "text", text: errorMessage }] }` with actionable error messages.

- [ ] **Step 2: Add tool descriptions with usage hints**

Each tool description should include:
- What it does
- Example usage
- Known limitations (e.g., restart_from_stage requires Declarative Pipeline plugin)

- [ ] **Step 3: Build final version**

Run: `npm run build`

- [ ] **Step 4: Test MCP server starts correctly**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node dist/index.js 2>/dev/null`
Expected: JSON response with server capabilities and tool list

- [ ] **Step 5: Create README.md with setup instructions**

Include:
- What it does
- Installation
- Claude Code configuration JSON
- Environment variables
- Tool list with descriptions

- [ ] **Step 6: Final commit**

```bash
git add -A && git commit -m "feat: polish error handling, tool descriptions, and README"
```
