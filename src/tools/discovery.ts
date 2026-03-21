import { z } from "zod";
import type { JenkinsClient } from "../jenkins-client.js";
import type { QueueItem, ToolResult } from "../types.js";
import { formatQueue, ok, error } from "../utils/formatters.js";

export function registerDiscoveryTools(
  client: JenkinsClient,
  register: (name: string, description: string, schema: z.ZodType, handler: (args: Record<string, unknown>) => Promise<ToolResult>) => void,
) {
  // 16. searchBuildLogs
  register(
    "searchBuildLogs",
    "Search build logs for a text pattern across recent builds. Like grep for Jenkins logs. Searches the last N builds (default: 5) and returns matching lines with context.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      pattern: z.string().describe("Text pattern to search for (case-insensitive substring match)"),
      buildNumber: z.number().optional().describe("Search a specific build number only"),
      lastN: z.number().optional().default(5).describe("Number of recent builds to search (default: 5, max: 20)"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const pattern = args.pattern as string;
      const buildNumber = args.buildNumber as number | undefined;
      const lastN = Math.min((args.lastN as number) || 5, 20);

      try {
        const patternLower = pattern.toLowerCase();
        const results: string[] = [];

        if (buildNumber) {
          // Search specific build
          const matches = await searchBuildLog(client, jobPath, buildNumber, patternLower);
          if (matches.length > 0) {
            results.push(`Build #${buildNumber} (${matches.length} matches):`);
            results.push(...matches.map((m) => `  L${m.line}: ${m.text}`));
          }
        } else {
          // Get recent builds
          const data = await client.get(jobPath, "/api/json", {
            tree: "builds[number]{0," + lastN + "}",
          });
          const jobData = data as { builds?: Array<{ number: number }> };
          const builds = jobData.builds || [];

          for (const build of builds) {
            const matches = await searchBuildLog(client, jobPath, build.number, patternLower);
            if (matches.length > 0) {
              results.push(`Build #${build.number} (${matches.length} matches):`);
              results.push(...matches.slice(0, 20).map((m) => `  L${m.line}: ${m.text}`));
              if (matches.length > 20) {
                results.push(`  ... and ${matches.length - 20} more matches`);
              }
              results.push("");
            }
          }
        }

        if (results.length === 0) {
          return ok(`No matches found for "${pattern}" in ${buildNumber ? `build #${buildNumber}` : `last ${lastN} builds`}.`);
        }

        return ok(`Search results for "${pattern}":\n\n${results.join("\n")}`);
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 17. getQueue
  register(
    "getQueue",
    "View the Jenkins build queue - shows jobs waiting to be built, why they're waiting, and if they're stuck.",
    z.object({}),
    async () => {
      try {
        const data = await client.getAbsolute("/queue/api/json", {
          tree: "items[id,task[name,url],why,buildableStartMilliseconds,stuck,blocked]",
        });
        const queue = data as { items: QueueItem[] };
        return ok(formatQueue(queue.items || []));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 18. enableDisableJob
  register(
    "enableDisableJob",
    "Enable or disable a Jenkins job. Disabled jobs cannot be triggered.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      enabled: z.boolean().describe("true to enable, false to disable"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const enabled = args.enabled as boolean;

      try {
        const action = enabled ? "/enable" : "/disable";
        await client.post(jobPath, action);
        return ok(`Job ${jobPath} ${enabled ? "enabled" : "disabled"} successfully.`);
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

async function searchBuildLog(
  client: JenkinsClient,
  jobPath: string,
  buildNumber: number,
  patternLower: string,
): Promise<Array<{ line: number; text: string }>> {
  try {
    const logText = await client.getRaw(jobPath, `/${buildNumber}/consoleText`);
    const lines = logText.split("\n");
    const matches: Array<{ line: number; text: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(patternLower)) {
        matches.push({
          line: i + 1,
          text: lines[i].substring(0, 200), // Truncate long lines
        });
      }
    }
    return matches;
  } catch {
    return [];
  }
}

function handleError(e: unknown): ToolResult {
  if (e && typeof e === "object" && "errorCode" in e) {
    const je = e as { errorCode: string; message: string; statusCode: number };
    return error(`[${je.errorCode}] ${je.message}`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return error(msg);
}
