import { z } from "zod";
import type { JenkinsClient } from "../jenkins-client.js";
import type { PipelineRun, PipelineStage, ToolResult } from "../types.js";
import { formatStages, formatDuration, ok, error, truncateText } from "../utils/formatters.js";

export function registerPipelineTools(
  client: JenkinsClient,
  register: (name: string, description: string, schema: z.ZodType, handler: (args: Record<string, unknown>) => Promise<ToolResult>) => void,
  allowUnsafe: boolean,
) {
  // 11. getPipelineStages
  register(
    "getPipelineStages",
    "Get pipeline stages overview for a build - shows stage names, status, and duration. Works with Pipeline (Workflow) jobs. Useful for understanding which stage failed.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().optional().describe("Build number (default: last build)"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number | undefined;
      const num = buildNumber ?? "lastBuild";

      try {
        const data = await client.get(jobPath, `/${num}/wfapi/describe`);
        const run = data as PipelineRun;
        if (!run.stages || run.stages.length === 0) {
          return ok("No pipeline stages found. This may not be a Pipeline job, or the build hasn't started stages yet.");
        }
        return ok(formatStages(run.stages));
      } catch (e) {
        return handleError(e, "This endpoint requires a Pipeline (Workflow) job. Classic Freestyle jobs don't have stages.");
      }
    },
  );

  // 12. getStageLog
  register(
    "getStageLog",
    "Get the console log for a specific pipeline stage. Provide the stage name as it appears in getPipelineStages output.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().describe("Build number"),
      stageName: z.string().describe("Stage name (as shown in getPipelineStages)"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number;
      const stageName = args.stageName as string;

      try {
        // First, get the pipeline description to find the stage ID
        const data = await client.get(jobPath, `/${buildNumber}/wfapi/describe`);
        const run = data as PipelineRun;
        const stage = run.stages?.find(
          (s) => s.name.toLowerCase() === stageName.toLowerCase(),
        );

        if (!stage) {
          const available = run.stages?.map((s) => s.name).join(", ") || "none";
          return error(
            `Stage "${stageName}" not found.`,
            `Available stages: ${available}`,
          );
        }

        // Get the stage log using the node ID
        const logData = await client.getRaw(
          jobPath,
          `/${buildNumber}/execution/node/${stage.id}/wfapi/log`,
        );

        // The wfapi/log endpoint returns JSON with a text field
        let logText: string;
        try {
          const parsed = JSON.parse(logData) as { text: string; hasMore: boolean };
          logText = parsed.text;
        } catch {
          // If it's not JSON, use raw text
          logText = logData;
        }

        // Strip HTML tags that Jenkins sometimes includes
        logText = logText.replace(/<[^>]*>/g, "");

        return ok(truncateText(
          `--- Stage Log: ${stage.name} (${stage.status}, ${formatDuration(stage.durationMillis)}) ---\n\n${logText}`,
        ));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 13. getPipelineScript
  register(
    "getPipelineScript",
    "Get the Jenkinsfile/pipeline script used in a build. Fetches from the replay page. Useful for reviewing or modifying the script before replaying.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().describe("Build number"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number;

      try {
        const html = await client.getRaw(jobPath, `/${buildNumber}/replay`);

        // Parse the main script from the replay page
        // The replay page has a <textarea> with class "ace-editor" or name "_.mainScript"
        const mainScriptMatch = html.match(
          /name="_.mainScript"[^>]*>([\s\S]*?)<\/textarea>/,
        );

        const scripts: { name: string; content: string }[] = [];

        if (mainScriptMatch) {
          // Decode HTML entities
          const script = decodeHtmlEntities(mainScriptMatch[1]);
          scripts.push({ name: "Jenkinsfile (main)", content: script });
        }

        // Also look for loaded library scripts
        const scriptBlocks = html.matchAll(
          /name="_.([^"]+)"[^>]*class="[^"]*jenkins-readonly-crumb[^"]*"[^>]*>([\s\S]*?)<\/textarea>/g,
        );
        for (const match of scriptBlocks) {
          if (match[1] !== "mainScript") {
            scripts.push({
              name: match[1],
              content: decodeHtmlEntities(match[2]),
            });
          }
        }

        // Try alternative pattern if nothing found
        if (scripts.length === 0) {
          // Try finding any textarea with script content
          const textareaMatches = html.matchAll(
            /<textarea[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g,
          );
          for (const match of textareaMatches) {
            const name = match[1].replace("_.", "");
            if (name && match[2].trim()) {
              scripts.push({
                name,
                content: decodeHtmlEntities(match[2]),
              });
            }
          }
        }

        if (scripts.length === 0) {
          return error(
            "Could not extract pipeline script from replay page.",
            "The build may not be a Pipeline job, or replay may not be available.",
          );
        }

        const lines: string[] = [];
        for (const s of scripts) {
          lines.push(`=== ${s.name} ===`);
          lines.push(s.content);
          lines.push("");
        }

        return ok(truncateText(lines.join("\n")));
      } catch (e) {
        return handleError(e, "Replay page may not be available. Ensure the build is a Pipeline job.");
      }
    },
  );

  // 14. replayBuild (unsafe — requires JENKINS_ALLOW_UNSAFE_OPERATIONS=true)
  if (allowUnsafe) {
    register(
      "replayBuild",
      "Replay a pipeline build with optional script modifications. If no script is provided, replays with the same script. Use getPipelineScript first to get the current script, modify it, then replay.",
      z.object({
        jobPath: z.string().describe("Full job path"),
        buildNumber: z.number().describe("Build number to replay"),
        mainScript: z.string().optional().describe("Modified Jenkinsfile content. If omitted, replays with the original script."),
      }),
      async (args) => {
        const jobPath = args.jobPath as string;
        const buildNumber = args.buildNumber as number;
        let mainScript = args.mainScript as string | undefined;

        try {
          // If no script provided, fetch current one
          if (!mainScript) {
            const html = await client.getRaw(jobPath, `/${buildNumber}/replay`);
            const match = html.match(
              /name="_.mainScript"[^>]*>([\s\S]*?)<\/textarea>/,
            );
            if (match) {
              mainScript = decodeHtmlEntities(match[1]);
            } else {
              return error(
                "Could not extract current pipeline script for replay.",
                "Try providing the script explicitly via the mainScript parameter.",
              );
            }
          }

          // Submit replay
          const formData = new URLSearchParams();
          formData.set("mainScript", mainScript);
          formData.set(
            "json",
            JSON.stringify({ mainScript }),
          );

          const result = await client.postForm(
            jobPath,
            `/${buildNumber}/replay/run`,
            formData,
          );

          // The response redirects to the new build page
          const location = result.response.headers.get("location");
          if (location) {
            return ok(`Replay triggered successfully.\nNew build: ${location}`);
          }
          return ok(`Replay triggered for ${jobPath} build #${buildNumber}.`);
        } catch (e) {
          return handleError(e, "Replay requires Pipeline job type and appropriate permissions.");
        }
      },
    );
  }

  // 15. restartFromStage
  register(
    "restartFromStage",
    "Restart a pipeline from a specific stage. Requires the Declarative Pipeline plugin with 'Restart from Stage' support. Only works with top-level stages in Declarative pipelines and completed builds.",
    z.object({
      jobPath: z.string().describe("Full job path"),
      buildNumber: z.number().describe("Build number"),
      stageName: z.string().describe("Stage name to restart from"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      const buildNumber = args.buildNumber as number;
      const stageName = args.stageName as string;

      try {
        // First verify the stage exists
        const data = await client.get(jobPath, `/${buildNumber}/wfapi/describe`);
        const run = data as PipelineRun;
        const stage = run.stages?.find(
          (s) => s.name.toLowerCase() === stageName.toLowerCase(),
        );

        if (!stage) {
          const available = run.stages?.map((s) => s.name).join(", ") || "none";
          return error(
            `Stage "${stageName}" not found.`,
            `Available stages: ${available}`,
          );
        }

        // Try the restart endpoint
        // This uses the Pipeline: Stage Step plugin's restart functionality
        const formData = new URLSearchParams();
        formData.set("stageName", stage.name);
        formData.set(
          "json",
          JSON.stringify({ stageName: stage.name }),
        );

        const result = await client.postForm(
          jobPath,
          `/${buildNumber}/restart/restart`,
          formData,
        );

        const location = result.response.headers.get("location");
        if (location) {
          return ok(`Restart from stage "${stage.name}" triggered.\nNew build: ${location}`);
        }
        return ok(`Restart from stage "${stage.name}" triggered for ${jobPath} build #${buildNumber}.`);
      } catch (e) {
        return handleError(
          e,
          "Restart from stage requires: (1) Declarative Pipeline plugin, (2) a completed build, (3) a top-level stage. Not all Jenkins installations support this.",
        );
      }
    },
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function handleError(e: unknown, suggestion?: string): ToolResult {
  if (e && typeof e === "object" && "errorCode" in e) {
    const je = e as { errorCode: string; message: string; statusCode: number };
    return error(`[${je.errorCode}] ${je.message}`, suggestion);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return error(msg, suggestion);
}
