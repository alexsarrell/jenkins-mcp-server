import { z } from "zod";
import type { JenkinsClient } from "../jenkins-client.js";
import type { QueueItem, QueueItemDetail, ToolResult } from "../types.js";
import { formatQueue, formatQueueItem, ok, error, truncateText } from "../utils/formatters.js";

export function registerDiscoveryTools(
  client: JenkinsClient,
  register: (name: string, description: string, schema: z.ZodType, handler: (args: Record<string, unknown>) => Promise<ToolResult>) => void,
) {
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

  // 18. getQueueItem
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

  // 19. enableDisableJob
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

function handleError(e: unknown): ToolResult {
  if (e && typeof e === "object" && "errorCode" in e) {
    const je = e as { errorCode: string; message: string; statusCode: number };
    return error(`[${je.errorCode}] ${je.message}`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return error(msg);
}
