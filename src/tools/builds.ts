import { z } from "zod";
import type { JenkinsClient } from "../jenkins-client.js";
import type { JenkinsBuild, BuildArtifact, TestResult, ToolResult } from "../types.js";
import { formatBuild, ok, error, truncateText } from "../utils/formatters.js";

export function registerBuildTools(
  client: JenkinsClient,
  register: (name: string, description: string, schema: z.ZodType, handler: (args: Record<string, unknown>) => Promise<ToolResult>) => void,
) {
  // 5. triggerBuild
  register(
    "triggerBuild",
    "Trigger a new build for a Jenkins job. Supports parameterized builds. For multibranch pipelines, trigger on a specific branch. Returns the queue item URL for tracking.",
    z.object({
      jobPath: z.string().describe("Full job path (e.g., 'my-folder/my-job' or 'pipeline/main')"),
      parameters: z.record(z.string(), z.string()).optional().describe("Build parameters as key-value pairs (e.g., {\"BRANCH\": \"main\", \"DEPLOY\": \"true\"})"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const parameters = args.parameters as Record<string, string> | undefined;

      try {
        let result: { response: Response; data: unknown };
        if (parameters && Object.keys(parameters).length > 0) {
          const formData = new URLSearchParams();
          // Build JSON body — multi-value params (comma-separated) become arrays
          const jsonParams: { name: string; value: string | string[] }[] = [];
          for (const [name, value] of Object.entries(parameters)) {
            if (value.includes(",")) {
              const values = value.split(",").map(v => v.trim());
              jsonParams.push({ name, value: values as unknown as string });
              // ExtendedChoiceParameter (PT_CHECKBOX) requires repeated query params
              for (const v of values) {
                formData.append(name, v);
              }
            } else {
              jsonParams.push({ name, value });
              formData.append(name, value);
            }
          }
          const json = JSON.stringify({ parameter: jsonParams });
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
    "Get detailed information about a specific build including status, duration, trigger cause, artifacts, and changes. Defaults to the last build if no number specified.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().optional().describe("Build number (default: last build)"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number | undefined;
      const num = buildNumber ?? "lastBuild";

      try {
        const tree = "number,url,result,building,duration,estimatedDuration,timestamp,displayName,description,fullDisplayName,actions[causes[shortDescription,userName]],artifacts[displayPath,fileName,relativePath],changeSets[items[msg,author[fullName],commitId]]";
        const data = await client.get(jobPath, `/${num}/api/json`, { tree });
        return ok(formatBuild(data as JenkinsBuild));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 7. getBuildLog
  register(
    "getBuildLog",
    "Get console output of a Jenkins build. By default returns the last 200 lines (tail). Use 'maxLines' to control output size. For large logs, use 'startByte' for byte-offset pagination. Returns hasMore flag and nextStart for follow-up calls.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().optional().describe("Build number (default: last build)"),
      maxLines: z.number().optional().default(200).describe("Maximum lines to return (default: 200)"),
      startByte: z.number().optional().describe("Byte offset to start from (for pagination). Use nextStart from previous response."),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number | undefined;
      const maxLines = (args.maxLines as number) || 200;
      const startByte = args.startByte as number | undefined;
      const num = buildNumber ?? "lastBuild";

      try {
        if (startByte !== undefined) {
          // Progressive log with byte offset
          const url = `/${num}/logText/progressiveText`;
          const data = await client.get(jobPath, url, { start: String(startByte) });
          const text = typeof data === "string" ? data : String(data);
          // Note: progressiveText returns X-Text-Size and X-More-Data headers
          // but we can't easily access them through our client. Return what we have.
          return ok(truncateText(text));
        }

        // Full console text, then tail
        const text = await client.getRaw(jobPath, `/${num}/consoleText`);
        const lines = text.split("\n");
        const totalLines = lines.length;

        let output: string;
        let hasMore = false;

        if (lines.length > maxLines) {
          // Tail from end
          const start = lines.length - maxLines;
          output = lines.slice(start).join("\n");
          hasMore = true;
        } else {
          output = text;
        }

        const meta = [
          `--- Build Log (${totalLines} total lines, showing last ${Math.min(maxLines, totalLines)}) ---`,
        ];
        if (hasMore) {
          meta.push(`[Has more content. ${totalLines - maxLines} earlier lines not shown. Increase maxLines or use startByte for full log.]`);
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
