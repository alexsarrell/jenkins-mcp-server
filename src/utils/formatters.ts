import type { JenkinsJob, JenkinsBuild, PipelineStage, QueueItem, ToolResult } from "../types.js";

const MAX_RESPONSE_BYTES = 100_000;

export function truncateText(text: string, maxBytes: number = MAX_RESPONSE_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Binary search for safe cut point
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.substring(0, mid), "utf8") <= maxBytes - 200) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.substring(0, low) + "\n\n... [TRUNCATED - response exceeded 100KB. Use pagination or search to get specific parts.]";
}

export function formatJobStatus(color: string): string {
  const statusMap: Record<string, string> = {
    blue: "SUCCESS",
    red: "FAILURE",
    yellow: "UNSTABLE",
    grey: "NOT_BUILT",
    disabled: "DISABLED",
    aborted: "ABORTED",
    notbuilt: "NOT_BUILT",
    blue_anime: "RUNNING (was SUCCESS)",
    red_anime: "RUNNING (was FAILURE)",
    yellow_anime: "RUNNING (was UNSTABLE)",
    grey_anime: "RUNNING",
  };
  if (!color) return "UNKNOWN";
  return statusMap[color] || color.toUpperCase();
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

export function formatJobList(jobs: JenkinsJob[]): string {
  if (jobs.length === 0) return "No jobs found.";

  const lines = jobs.map((job) => {
    const status = formatJobStatus(job.color);
    const lastBuild = job.lastBuild
      ? `#${job.lastBuild.number} (${job.lastBuild.result || "RUNNING"})`
      : "no builds";
    const desc = job.description ? ` - ${job.description}` : "";
    return `  ${status}  ${job.name}  [${lastBuild}]${desc}`;
  });

  return `Jobs (${jobs.length}):\n${lines.join("\n")}`;
}

export function formatJobDetail(job: JenkinsJob): string {
  const lines: string[] = [];
  lines.push(`Job: ${job.fullName || job.name}`);
  lines.push(`Status: ${formatJobStatus(job.color)}`);
  if (job.description) lines.push(`Description: ${job.description}`);
  lines.push(`Buildable: ${job.buildable ?? "unknown"}`);
  lines.push(`URL: ${job.url}`);

  if (job.healthReport && job.healthReport.length > 0) {
    lines.push(`Health: ${job.healthReport.map((h) => `${h.score}% - ${h.description}`).join("; ")}`);
  }

  if (job.lastBuild) {
    lines.push(`Last Build: #${job.lastBuild.number} (${job.lastBuild.result || "RUNNING"}) at ${formatTimestamp(job.lastBuild.timestamp)}`);
  }

  // Parameter definitions
  const paramProp = job.property?.find((p) => p.parameterDefinitions && p.parameterDefinitions.length > 0);
  if (paramProp?.parameterDefinitions) {
    lines.push("\nParameters:");
    for (const param of paramProp.parameterDefinitions) {
      const def = param.defaultParameterValue?.value ?? "(no default)";
      lines.push(`  - ${param.name} (${param.type}): ${param.description || "no description"} [default: ${def}]`);
    }
  }

  // Sub-jobs (for folders/multibranch)
  if (job.jobs && job.jobs.length > 0) {
    lines.push(`\nBranches/Sub-jobs (${job.jobs.length}):`);
    for (const sub of job.jobs.slice(0, 50)) {
      lines.push(`  ${formatJobStatus(sub.color)}  ${sub.name}`);
    }
    if (job.jobs.length > 50) {
      lines.push(`  ... and ${job.jobs.length - 50} more`);
    }
  }

  return lines.join("\n");
}

export function formatBuild(build: JenkinsBuild): string {
  const lines: string[] = [];
  lines.push(`Build: ${build.fullDisplayName || `#${build.number}`}`);
  lines.push(`Result: ${build.building ? "RUNNING" : build.result || "UNKNOWN"}`);
  lines.push(`Duration: ${formatDuration(build.duration || 0)}${build.building ? ` (estimated: ${formatDuration(build.estimatedDuration)})` : ""}`);
  lines.push(`Started: ${formatTimestamp(build.timestamp)}`);
  if (build.description) lines.push(`Description: ${build.description}`);
  lines.push(`URL: ${build.url}`);

  // Build causes
  const causes = build.actions
    ?.filter((a) => a.causes)
    .flatMap((a) => a.causes!)
    .map((c) => c.shortDescription);
  if (causes && causes.length > 0) {
    lines.push(`Triggered by: ${causes.join(", ")}`);
  }

  // Artifacts
  if (build.artifacts && build.artifacts.length > 0) {
    lines.push(`\nArtifacts (${build.artifacts.length}):`);
    for (const a of build.artifacts) {
      lines.push(`  - ${a.fileName} (${a.relativePath})`);
    }
  }

  // Changes
  if (build.changeSets) {
    const allChanges = build.changeSets.flatMap((cs) => cs.items);
    if (allChanges.length > 0) {
      lines.push(`\nChanges (${allChanges.length}):`);
      for (const c of allChanges.slice(0, 20)) {
        lines.push(`  - ${c.commitId.substring(0, 8)} ${c.author.fullName}: ${c.msg}`);
      }
    }
  }

  return lines.join("\n");
}

export function formatStages(stages: PipelineStage[]): string {
  if (stages.length === 0) return "No pipeline stages found.";

  const lines = ["Pipeline Stages:"];
  for (const stage of stages) {
    const status = stage.status === "SUCCESS" ? "OK" : stage.status;
    lines.push(`  ${status}  ${stage.name}  [${formatDuration(stage.durationMillis)}]`);
  }
  return lines.join("\n");
}

export function formatQueue(items: QueueItem[]): string {
  if (items.length === 0) return "Build queue is empty.";

  const lines = [`Build Queue (${items.length} items):`];
  for (const item of items) {
    const status = item.stuck ? "STUCK" : item.blocked ? "BLOCKED" : "WAITING";
    lines.push(`  #${item.id} ${item.task.name} [${status}]${item.why ? ` - ${item.why}` : ""}`);
  }
  return lines.join("\n");
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text: truncateText(text) }] };
}

export function error(message: string, suggestion?: string): ToolResult {
  let text = `Error: ${message}`;
  if (suggestion) text += `\nSuggestion: ${suggestion}`;
  return { content: [{ type: "text", text }], isError: true };
}
