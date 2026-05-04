import { describe, it, expect } from "vitest";
import { diffJobSpecs } from "../../src/utils/job-diff.js";
import type { JobDescription } from "../../src/utils/job-xml.js";

const base: JobDescription = {
  type: "pipeline",
  description: "old desc",
  disabled: false,
  concurrentBuilds: false,
  scm: { type: "git", url: "https://e.com/r.git", branches: ["main"], jenkinsfilePath: "Jenkinsfile" },
  unknownXmlElements: [],
  rawConfigSha: "abc",
};

describe("diffJobSpecs", () => {
  it("detects a description change", () => {
    const out = diffJobSpecs(base, { ...base, description: "new desc" });
    expect(out).toEqual([{ path: "description", before: "old desc", after: "new desc" }]);
  });

  it("detects a nested scm field change", () => {
    const out = diffJobSpecs(base, { ...base, scm: { ...base.scm!, url: "https://e.com/r2.git" } });
    expect(out).toEqual([{ path: "scm.url", before: "https://e.com/r.git", after: "https://e.com/r2.git" }]);
  });

  it("ignores rawConfigSha", () => {
    const out = diffJobSpecs(base, { ...base, rawConfigSha: "xyz" });
    expect(out).toEqual([]);
  });
});
