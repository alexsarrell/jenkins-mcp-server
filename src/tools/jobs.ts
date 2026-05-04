import { z } from "zod";
import type { JenkinsClient } from "../jenkins-client.js";
import type { JenkinsJob, ToolResult } from "../types.js";
import { formatJobList, formatJobDetail, ok, error, truncateText } from "../utils/formatters.js";
import { mapJenkinsParameter, type JenkinsParameterDefinition } from "../utils/parameter-mapper.js";
import { parseJobConfig } from "../utils/job-xml.js";
import type { ParameterSpec } from "../schemas/parameter.js";

export function registerJobTools(
  client: JenkinsClient,
  register: (name: string, description: string, schema: z.ZodType, handler: (args: Record<string, unknown>) => Promise<ToolResult>) => void,
  allowUnsafe: boolean,
) {
  // 1. getJobs
  register(
    "getJobs",
    "List Jenkins jobs at root level or in a specific folder. Returns job names, status, and last build info. For multibranch pipelines, lists branches as sub-jobs.",
    z.object({
      folder: z.string().optional().describe("Folder path (e.g., 'my-folder' or 'folder/subfolder'). Omit for root level."),
      limit: z.number().optional().default(50).describe("Maximum number of jobs to return (default: 50)"),
    }),
    async (args) => {
      const folder = args.folder as string | undefined;
      const limit = (args.limit as number) || 50;

      try {
        const tree = "jobs[name,url,color,description,fullName,lastBuild[number,result,timestamp]]";
        let data: unknown;
        if (folder) {
          data = await client.get(folder, "/api/json", { tree });
        } else {
          data = await client.getAbsolute("/api/json", { tree });
        }

        const result = data as { jobs?: JenkinsJob[] };
        const jobs = (result.jobs || []).slice(0, limit);
        return ok(formatJobList(jobs));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 2. getJob
  register(
    "getJob",
    "Get detailed information about a specific Jenkins job including status, health, parameter definitions, and last build info. For multibranch pipelines, also lists branches.",
    z.object({
      jobPath: z.string().describe("Full job path (e.g., 'my-folder/my-job' or 'pipeline/main'). For branches with slashes, use :: separator: 'pipeline::feature/branch'"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      try {
        const tree = "name,fullName,url,color,description,buildable,healthReport[description,score],lastBuild[number,result,timestamp,url],lastSuccessfulBuild[number,url],lastFailedBuild[number,url],property[parameterDefinitions[name,type,description,defaultParameterValue[value]]],jobs[name,color,url,fullName]";
        const data = await client.get(jobPath, "/api/json", { tree });
        return ok(formatJobDetail(data as JenkinsJob));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 3. getJobConfig
  register(
    "getJobConfig",
    "Get the XML configuration of a Jenkins job (config.xml). Useful for understanding job setup, viewing pipeline definitions, or preparing edits.",
    z.object({
      jobPath: z.string().describe("Full job path (e.g., 'my-folder/my-job')"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      try {
        const xml = await client.getRaw(jobPath, "/config.xml");
        return ok(truncateText(xml));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 3b. getJobParameters
  register(
    "getJobParameters",
    "Get the structured parameter schema for a Jenkins job. Returns each parameter's type (string/choice/boolean/password/file/run/credentials/unknown), default, choices, and description as JSON. Use this instead of getJob when you need to know what to pass to triggerBuild.",
    z.object({
      jobPath: z.string().describe("Full job path"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      try {
        const tree = "property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices,projectName,credentialType,_class]]";
        const data = await client.get(jobPath, "/api/json", { tree });
        const job = data as {
          property?: Array<{ parameterDefinitions?: JenkinsParameterDefinition[] }>;
        };
        const defs = (job.property ?? []).flatMap((p) => p.parameterDefinitions ?? []);
        const parameters: ParameterSpec[] = defs.map(mapJenkinsParameter);
        return ok(JSON.stringify({ parameters }, null, 2));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 3c. describeJob
  register(
    "describeJob",
    "Get a structured view of a job's config (SCM url/branch, Jenkinsfile path, parameters, retention, cron) without parsing raw XML. Reports unrecognised XML elements via 'unknownXmlElements'. Read-only and safe.",
    z.object({
      jobPath: z.string().describe("Full job path"),
    }),
    async (args) => {
      const jobPath = args.jobPath as string;
      try {
        const xml = await client.getRaw(jobPath, "/config.xml");
        const desc = parseJobConfig(xml);
        return ok(JSON.stringify(desc, null, 2));
      } catch (e) {
        return handleError(e);
      }
    },
  );

  // 4. updateJobConfig (unsafe — requires JENKINS_ALLOW_UNSAFE_OPERATIONS=true)
  if (allowUnsafe) {
    register(
      "updateJobConfig",
      "Update a Jenkins job's XML configuration. Send the complete config.xml content. Use getJobConfig first to read the current config, modify it, then submit.",
      z.object({
        jobPath: z.string().describe("Full job path (e.g., 'my-folder/my-job')"),
        configXml: z.string().describe("Complete XML configuration for the job"),
      }),
      async (args) => {
        const jobPath = args.jobPath as string;
        const configXml = args.configXml as string;
        try {
          await client.post(jobPath, "/config.xml", configXml, "application/xml");
          return ok(`Job config updated successfully: ${jobPath}`);
        } catch (e) {
          return handleError(e);
        }
      },
    );
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
