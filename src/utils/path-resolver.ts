/**
 * Converts a human-readable job path like "my-folder/my-pipeline/feature/my-branch"
 * into Jenkins URL path segments like "/job/my-folder/job/my-pipeline/job/feature%2Fmy-branch".
 *
 * For multibranch pipelines, users provide paths as: folder/pipeline/branch
 * Branch names containing "/" are encoded as %2F in a single path segment.
 *
 * Since we can't always know which segments are folders vs branch names without
 * querying Jenkins, we treat each "/" as a job separator by default.
 * Users dealing with branches containing "/" should use the special "::" separator:
 *   "my-folder/my-pipeline::feature/my-branch"
 */
export function resolveJobPath(jobPath: string): string {
  // Handle the :: separator for branch names with slashes
  const branchSepIndex = jobPath.indexOf("::");
  let segments: string[];

  if (branchSepIndex !== -1) {
    const prefix = jobPath.substring(0, branchSepIndex);
    const branchName = jobPath.substring(branchSepIndex + 2);
    segments = [...prefix.split("/").filter(Boolean), branchName];
  } else {
    segments = jobPath.split("/").filter(Boolean);
  }

  return segments
    .map((segment) => `/job/${encodeURIComponent(segment)}`)
    .join("");
}

/**
 * Builds a full Jenkins API URL from base URL, job path, and optional suffix.
 */
export function buildJenkinsUrl(
  baseUrl: string,
  jobPath: string,
  suffix: string = "",
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const resolvedPath = resolveJobPath(jobPath);
  return `${base}${resolvedPath}${suffix}`;
}
