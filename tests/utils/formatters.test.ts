import { describe, it, expect } from "vitest";
import { formatBuild } from "../../src/utils/formatters.js";
import type { JenkinsBuild } from "../../src/types.js";

const buildBase: JenkinsBuild = {
  _class: "x",
  number: 42,
  url: "https://jenkins.example.com/job/x/42/",
  result: "SUCCESS",
  building: false,
  duration: 1000,
  estimatedDuration: 1000,
  timestamp: 1700000000000,
  displayName: "#42",
  fullDisplayName: "x #42",
  description: null,
};

describe("formatBuild parameters", () => {
  it("renders a parameters block when present", () => {
    const text = formatBuild({
      ...buildBase,
      actions: [
        {
          _class: "hudson.model.ParametersAction",
          parameters: [
            { _class: "hudson.model.StringParameterValue", name: "BRANCH", value: "main" },
            { _class: "hudson.model.BooleanParameterValue", name: "DRY_RUN", value: true },
          ],
        },
      ],
    });
    expect(text).toContain("Parameters:");
    expect(text).toContain("BRANCH = main");
    expect(text).toContain("DRY_RUN = true");
  });

  it("masks password parameter values", () => {
    const text = formatBuild({
      ...buildBase,
      actions: [
        {
          _class: "hudson.model.ParametersAction",
          parameters: [
            { _class: "hudson.model.PasswordParameterValue", name: "TOKEN", value: "" },
          ],
        },
      ],
    });
    expect(text).toContain("TOKEN = [hidden]");
    expect(text).not.toContain('""');
  });

  it("omits the parameters block when no parameters present", () => {
    const text = formatBuild({ ...buildBase, actions: [{ _class: "x", causes: [{ shortDescription: "Started by user" }] }] });
    expect(text).not.toContain("Parameters:");
  });
});
