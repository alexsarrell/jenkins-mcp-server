import { describe, it, expect } from "vitest";
import { mapJenkinsParameter } from "../../src/utils/parameter-mapper.js";

describe("mapJenkinsParameter", () => {
  it("maps StringParameterDefinition to type:string", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.StringParameterDefinition",
        name: "BRANCH",
        description: "Git branch",
        defaultParameterValue: { value: "main" },
      }),
    ).toEqual({ type: "string", name: "BRANCH", description: "Git branch", default: "main" });
  });

  it("maps ChoiceParameterDefinition with choices", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.ChoiceParameterDefinition",
        name: "ENV",
        description: "",
        choices: ["dev", "stage", "prod"],
        defaultParameterValue: { value: "dev" },
      }),
    ).toEqual({ type: "choice", name: "ENV", choices: ["dev", "stage", "prod"], default: "dev" });
  });

  it("maps BooleanParameterDefinition with boolean default", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.BooleanParameterDefinition",
        name: "DRY_RUN",
        description: "",
        defaultParameterValue: { value: true },
      }),
    ).toEqual({ type: "boolean", name: "DRY_RUN", default: true });
  });

  it("maps PasswordParameterDefinition without exposing default", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.PasswordParameterDefinition",
        name: "TOKEN",
        description: "API token",
        defaultParameterValue: { value: "" },
      }),
    ).toEqual({ type: "password", name: "TOKEN", description: "API token" });
  });

  it("maps FileParameterDefinition", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.FileParameterDefinition",
        name: "PATCH",
        description: "",
      }),
    ).toEqual({ type: "file", name: "PATCH" });
  });

  it("maps RunParameterDefinition", () => {
    expect(
      mapJenkinsParameter({
        _class: "hudson.model.RunParameterDefinition",
        name: "UPSTREAM",
        description: "",
        projectName: "upstream-job",
      }),
    ).toEqual({ type: "run", name: "UPSTREAM", projectName: "upstream-job" });
  });

  it("maps CredentialsParameterDefinition", () => {
    expect(
      mapJenkinsParameter({
        _class: "com.cloudbees.plugins.credentials.CredentialsParameterDefinition",
        name: "DEPLOY_KEY",
        description: "",
        credentialType: "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl",
      }),
    ).toEqual({
      type: "credentials",
      name: "DEPLOY_KEY",
      credentialType: "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl",
    });
  });

  it("falls back to type:unknown for unrecognised classes", () => {
    expect(
      mapJenkinsParameter({
        _class: "com.cwctravel.hudson.plugins.extended_choice_parameter.ExtendedChoiceParameterDefinition",
        name: "ECP",
        description: "Extended choice",
      }),
    ).toEqual({
      type: "unknown",
      name: "ECP",
      rawType: "com.cwctravel.hudson.plugins.extended_choice_parameter.ExtendedChoiceParameterDefinition",
      description: "Extended choice",
    });
  });

  it("strips empty description fields", () => {
    const out = mapJenkinsParameter({
      _class: "hudson.model.StringParameterDefinition",
      name: "FOO",
      description: "",
    });
    expect(out).toEqual({ type: "string", name: "FOO" });
  });
});
