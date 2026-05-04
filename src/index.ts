#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JenkinsClient } from "./jenkins-client.js";
import type { ToolResult } from "./types.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerBuildTools } from "./tools/builds.js";
import { registerPipelineTools } from "./tools/pipeline.js";
import { registerDiscoveryTools } from "./tools/discovery.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

// Validate environment variables
const JENKINS_URL = process.env.JENKINS_URL;
const JENKINS_USER = process.env.JENKINS_USER;
const JENKINS_API_TOKEN = process.env.JENKINS_API_TOKEN;

if (!JENKINS_URL || !JENKINS_USER || !JENKINS_API_TOKEN) {
  console.error(
    "Missing required environment variables. Please set:\n" +
      "  JENKINS_URL       - Jenkins server URL (e.g., https://jenkins.example.com)\n" +
      "  JENKINS_USER      - Jenkins username\n" +
      "  JENKINS_API_TOKEN - Jenkins API token (generate at User > Configure > API Token)",
  );
  process.exit(1);
}

const ALLOW_UNSAFE = process.env.JENKINS_ALLOW_UNSAFE_OPERATIONS === "true";

// Create Jenkins client
const client = new JenkinsClient({
  url: JENKINS_URL,
  user: JENKINS_USER,
  token: JENKINS_API_TOKEN,
});

// Create MCP server
const server = new McpServer({
  name: "jenkins-mcp-server",
  version: pkg.version,
});

// Tool registration helper that wraps the McpServer.tool() API
function register(
  name: string,
  description: string,
  schema: z.ZodType,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
) {
  // The MCP SDK expects a ZodRawShape (object with zod fields), not a ZodObject
  // We need to extract the shape from our z.object() schemas
  const zodObject = schema as z.ZodObject<z.ZodRawShape>;
  server.tool(name, description, zodObject.shape, async (args) => {
    try {
      return await handler(args as Record<string, unknown>);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: `Unexpected error: ${msg}` }],
        isError: true,
      };
    }
  });
}

// Register all tools
registerJobTools(client, register, ALLOW_UNSAFE);
registerBuildTools(client, register);
registerPipelineTools(client, register, ALLOW_UNSAFE);
registerDiscoveryTools(client, register);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Jenkins MCP server started successfully.");
  console.error(`Connected to: ${JENKINS_URL}`);
  console.error(`User: ${JENKINS_USER}`);
  console.error(`Unsafe operations: ${ALLOW_UNSAFE ? "enabled" : "disabled"}`);
}

main().catch((e) => {
  console.error("Failed to start Jenkins MCP server:", e);
  process.exit(1);
});
