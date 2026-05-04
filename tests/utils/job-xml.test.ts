import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJobConfig, buildJobXml } from "../../src/utils/job-xml.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "../fixtures", name), "utf8");

describe("parseJobConfig", () => {
  it("parses a single-branch pipeline", () => {
    const out = parseJobConfig(fixture("pipeline-config.xml"));
    expect(out.type).toBe("pipeline");
    expect(out.description).toBe("Build and deploy the API");
    expect(out.disabled).toBe(false);
    expect(out.scm).toMatchObject({
      type: "git",
      url: "https://gitlab.example.com/my-team/api.git",
      credentialsId: "gitlab-token",
      jenkinsfilePath: "deploy/Jenkinsfile",
    });
    expect(out.scm?.branches).toEqual(["*/main"]);
    expect(out.parameters).toHaveLength(2);
    expect(out.parameters?.[0]).toMatchObject({ type: "string", name: "BRANCH", default: "main" });
    expect(out.parameters?.[1]).toMatchObject({ type: "boolean", name: "DRY_RUN" });
    expect(out.triggers?.cron).toBe("H 2 * * *");
    expect(out.buildRetention).toMatchObject({ daysToKeep: 30, numToKeep: 50 });
  });

  it("parses a multibranch project", () => {
    const out = parseJobConfig(fixture("multibranch-config.xml"));
    expect(out.type).toBe("multibranch");
    expect(out.scm).toMatchObject({
      type: "git",
      url: "https://gitlab.example.com/my-team/api.git",
      credentialsId: "gitlab-token",
      jenkinsfilePath: "Jenkinsfile",
    });
  });

  it("parses a freestyle project with limited fields and reports unknown elements", () => {
    const out = parseJobConfig(fixture("freestyle-config.xml"));
    expect(out.type).toBe("freestyle");
    expect(out.description).toBe("Freestyle deploy job");
    expect(out.concurrentBuilds).toBe(true);
    expect(out.unknownXmlElements).toEqual(expect.arrayContaining(["scm", "builders", "publishers"]));
  });

  it("returns type:unknown for unrecognised root elements", () => {
    const xml = `<?xml version='1.1' encoding='UTF-8'?><weird-root><foo/></weird-root>`;
    const out = parseJobConfig(xml);
    expect(out.type).toBe("unknown");
  });

  it("computes a stable rawConfigSha", () => {
    const xml = fixture("pipeline-config.xml");
    expect(parseJobConfig(xml).rawConfigSha).toBe(parseJobConfig(xml).rawConfigSha);
    expect(parseJobConfig(xml).rawConfigSha).not.toBe(parseJobConfig(xml + "\n").rawConfigSha);
  });
});

describe("buildJobXml", () => {
  it("builds a pipeline XML that round-trips through parseJobConfig", () => {
    const spec = {
      type: "pipeline" as const,
      description: "Test pipeline",
      disabled: false,
      scm: {
        type: "git" as const,
        url: "https://example.com/repo.git",
        branches: ["main"],
        credentialsId: "my-cred",
        jenkinsfilePath: "Jenkinsfile",
      },
      triggers: { cron: "H 5 * * *" },
      parameters: [{ type: "string" as const, name: "BRANCH", default: "main" }],
      buildRetention: { numToKeep: 20 },
    };
    const xml = buildJobXml(spec);
    const parsed = parseJobConfig(xml);
    expect(parsed.type).toBe("pipeline");
    expect(parsed.description).toBe("Test pipeline");
    expect(parsed.scm).toMatchObject({ type: "git", url: "https://example.com/repo.git", credentialsId: "my-cred", jenkinsfilePath: "Jenkinsfile" });
    expect(parsed.scm?.branches).toEqual(["main"]);
    expect(parsed.parameters?.[0]).toMatchObject({ type: "string", name: "BRANCH", default: "main" });
    expect(parsed.triggers?.cron).toBe("H 5 * * *");
    expect(parsed.buildRetention?.numToKeep).toBe(20);
  });

  it("builds a multibranch XML", () => {
    const xml = buildJobXml({
      type: "multibranch" as const,
      description: "MB",
      source: { type: "git" as const, url: "https://example.com/r.git" },
      jenkinsfilePath: "Jenkinsfile",
    });
    const parsed = parseJobConfig(xml);
    expect(parsed.type).toBe("multibranch");
    expect(parsed.scm).toMatchObject({ type: "git", url: "https://example.com/r.git", jenkinsfilePath: "Jenkinsfile" });
  });

  it("builds a folder XML", () => {
    const xml = buildJobXml({ type: "folder" as const, description: "My folder" });
    expect(xml).toContain("<com.cloudbees.hudson.plugins.folder.Folder");
    expect(xml).toContain("<description>My folder</description>");
  });

  it("XML-escapes user input", () => {
    const xml = buildJobXml({
      type: "folder" as const,
      description: "Has <evil> & \"quotes\"",
    });
    expect(xml).not.toContain("<evil>");
    expect(xml).toContain("&lt;evil&gt;");
    expect(xml).toContain("&amp;");
  });
});
