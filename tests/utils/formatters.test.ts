import { describe, it, expect } from "vitest";
import { formatBuild, formatQueueItem } from "../../src/utils/formatters.js";
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
    expect(text).toContain("Parameters (2):");
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
    expect(text).not.toContain("Parameters (");
  });
});

describe("formatQueueItem", () => {
  it("renders WAITING with reason", () => {
    const out = formatQueueItem({
      id: 7,
      task: { name: "deploy", url: "https://j/job/deploy/" },
      why: "Waiting for next available executor",
      _class: "hudson.model.Queue$WaitingItem",
    });
    expect(out).toContain("Queue item #7: WAITING");
    expect(out).toContain("Why: Waiting for next available executor");
  });

  it("renders LEFT_QUEUE with executable build info", () => {
    const out = formatQueueItem({
      id: 7,
      task: { name: "deploy", url: "https://j/job/deploy/" },
      why: null,
      _class: "hudson.model.Queue$LeftItem",
      executable: { number: 42, url: "https://j/job/deploy/42/" },
    });
    expect(out).toContain("Queue item #7: LEFT_QUEUE");
    expect(out).toContain("Build started: deploy #42");
    expect(out).toContain("https://j/job/deploy/42/");
  });

  it("renders CANCELLED", () => {
    const out = formatQueueItem({
      id: 7,
      task: { name: "deploy", url: "https://j/job/deploy/" },
      why: null,
      cancelled: true,
      _class: "hudson.model.Queue$CancelledItem",
    });
    expect(out).toContain("Queue item #7: CANCELLED");
  });

  it("falls back to UNKNOWN for unrecognised _class", () => {
    const out = formatQueueItem({
      id: 7,
      task: { name: "deploy", url: "https://j/job/deploy/" },
      why: null,
      _class: "hudson.model.Queue$WeirdItem",
    });
    expect(out).toContain("Queue item #7: UNKNOWN");
  });
});
