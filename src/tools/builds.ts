import { z } from "zod";
import type { JenkinsClient } from "../jenkins-client.js";
import type { JenkinsBuild, BuildArtifact, TestResult, ToolResult } from "../types.js";
import { formatBuild, ok, error, truncateText } from "../utils/formatters.js";
import { buildTriggerPayload, type ParameterValue } from "../utils/build-payload.js";
import { grepLog } from "../utils/log-grep.js";

export function registerBuildTools(
  client: JenkinsClient,
  register: (name: string, description: string, schema: z.ZodType, handler: (args: Record<string, unknown>) => Promise<ToolResult>) => void,
) {
  const DEFAULT_GET_BUILD_INCLUDE = ["causes", "parameters", "artifacts", "changes"] as const;

  // 5. triggerBuild
  register(
    "triggerBuild",
    "Trigger a new build for a Jenkins job. Supports parameterized builds. For multibranch pipelines, trigger on a specific branch. Returns the queue item URL for tracking.",
    z.object({
      jobPath: z.string().describe("Full job path (e.g., 'my-folder/my-job' or 'pipeline/main')"),
      parameters: z.record(z.string(), z.union([z.string(), z.array(z.string()).nonempty()])).optional()
        .describe("Build parameters. String values are submitted as-is (no comma splitting). Use string[] for multi-value parameters (ExtendedChoiceParameter, multi-select)."),
      splitOnComma: z.boolean().optional().default(false)
        .describe("[DEPRECATED] Legacy behaviour: split comma-bearing string values into multi-value submissions. Will be removed in v2.0. Prefer string[] values instead."),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const parameters = args.parameters as Record<string, ParameterValue> | undefined;

      try {
        let result: { response: Response; data: unknown };
        const splitOnComma = (args.splitOnComma as boolean) ?? false;

        if (parameters && Object.keys(parameters).length > 0) {
          const { formData, jsonParameters } = buildTriggerPayload(parameters, splitOnComma);
          // jsonParameters is reserved for the v1.3 FILE/CREDENTIALS payload; not sent today.
          void jsonParameters;
          result = await client.postForm(jobPath, "/buildWithParameters", formData);
        } else {
          result = await client.post(jobPath, "/build");
        }

        const location = result.response.headers.get("location");
        if (location) {
          // Extract queue ID from location header
          const match = location.match(/\/queue\/item\/(\d+)/);
          if (match) {
            return ok(`Build triggered successfully.\nQueue item: #${match[1]}\nTrack at: ${location}`);
          }
        }
        return ok(`Build triggered successfully for ${jobPath}.`);
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 6. getBuild
  register(
    "getBuild",
    "Get detailed information about a specific build including status, duration, trigger cause, parameters, artifacts, and changes. Defaults to the last build if no number specified. Use 'include' to control which optional sections are returned.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().optional().describe("Build number (default: last build)"),
      include: z.array(z.enum(["artifacts", "changes", "causes", "parameters"])).optional()
        .describe(`Sections to include. Default: ${JSON.stringify(DEFAULT_GET_BUILD_INCLUDE)}`),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number | undefined;
      const include = (args.include as string[] | undefined) ?? [...DEFAULT_GET_BUILD_INCLUDE];
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

  // 7. getBuildLog
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
          const blocks = result.matches.map((m, idx) => {
            const ctxLines = m.context.map((c) => `${String(c.lineNumber).padStart(6)}: ${c.text}`);
            return `=== match #${idx + 1} (line ${m.lineNumber}) ===\n${ctxLines.join("\n")}`;
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

  // 8. stopBuild
  register(
    "stopBuild",
    "Abort/stop a running Jenkins build.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().describe("Build number to stop"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number;

      try {
        await client.post(jobPath, `/${buildNumber}/stop`);
        return ok(`Build #${buildNumber} stop signal sent for ${jobPath}.`);
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 9. getBuildArtifacts
  register(
    "getBuildArtifacts",
    "List build artifacts with their file names and download paths.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().optional().describe("Build number (default: last build)"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number | undefined;
      const num = buildNumber ?? "lastBuild";

      try {
        const data = await client.get(jobPath, `/${num}/api/json`, {
          tree: "number,url,artifacts[displayPath,fileName,relativePath]",
        });
        const build = data as { number: number; url: string; artifacts: BuildArtifact[] };

        if (!build.artifacts || build.artifacts.length === 0) {
          return ok(`No artifacts found for build #${build.number}.`);
        }

        const lines = [`Artifacts for build #${build.number} (${build.artifacts.length}):`];
        for (const a of build.artifacts) {
          lines.push(`  - ${a.fileName} (${a.relativePath})`);
          lines.push(`    Download: ${build.url}artifact/${a.relativePath}`);
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 10. getBuildTestResults
  register(
    "getBuildTestResults",
    "Get test results for a build. By default shows only failures. Set onlyFailures=false to see all tests.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().optional().describe("Build number (default: last build)"),
      onlyFailures: z.boolean().optional().default(true).describe("Show only failing tests (default: true)"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number | undefined;
      const onlyFailures = args.onlyFailures as boolean ?? true;
      const num = buildNumber ?? "lastBuild";

      try {
        const data = await client.get(jobPath, `/${num}/testReport/api/json`, {
          tree: "failCount,passCount,skipCount,totalCount,suites[name,cases[className,name,status,duration,errorDetails,errorStackTrace]]",
        });
        const results = data as TestResult;

        const lines = [
          `Test Results for build #${num}:`,
          `  Total: ${results.totalCount}  Passed: ${results.passCount}  Failed: ${results.failCount}  Skipped: ${results.skipCount}`,
        ];

        if (results.suites) {
          const allCases = results.suites.flatMap((s) => s.cases);
          const filtered = onlyFailures
            ? allCases.filter((c) => c.status === "FAILED" || c.status === "REGRESSION")
            : allCases;

          if (filtered.length > 0) {
            lines.push(`\n${onlyFailures ? "Failed" : "All"} Tests (${filtered.length}):`);
            for (const tc of filtered.slice(0, 100)) {
              lines.push(`  ${tc.status}  ${tc.className}.${tc.name} (${tc.duration.toFixed(2)}s)`);
              if (tc.errorDetails) {
                lines.push(`    Error: ${tc.errorDetails.substring(0, 500)}`);
              }
            }
            if (filtered.length > 100) {
              lines.push(`  ... and ${filtered.length - 100} more`);
            }
          } else if (onlyFailures) {
            lines.push("\nNo test failures.");
          }
        }

        return ok(lines.join("\n"));
      } catch (e) {
        // 404 often means no test results
        if (e && typeof e === "object" && "statusCode" in e && (e as { statusCode: number }).statusCode === 404) {
          return ok(`No test results found for build #${num}. The build may not have any test reports.`);
        }
        return handleError(e);
      }
    },
  );
}

function handleError(e: unknown): ToolResult {
  if (e && typeof e === "object" && "errorCode" in e) {
    const je = e as { errorCode: string; message: string; statusCode: number };
    return error(`[${je.errorCode}] ${je.message}`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return error(msg);
}
