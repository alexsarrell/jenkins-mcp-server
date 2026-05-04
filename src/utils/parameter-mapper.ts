import type { ParameterSpec } from "../schemas/parameter.js";

export interface JenkinsParameterDefinition {
  _class?: string;
  name: string;
  description?: string;
  defaultParameterValue?: { value?: string | boolean | number };
  choices?: string[];
  projectName?: string;
  credentialType?: string;
}

export function mapJenkinsParameter(p: JenkinsParameterDefinition): ParameterSpec {
  const cls = p._class || "";
  const last = cls.split(".").pop() || "";
  const desc = p.description || undefined;
  const rawDefault = p.defaultParameterValue?.value;

  if (last === "StringParameterDefinition") {
    const out: ParameterSpec = { type: "string", name: p.name };
    if (typeof rawDefault === "string" && rawDefault !== "") out.default = rawDefault;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "TextParameterDefinition") {
    const out: ParameterSpec = { type: "text", name: p.name };
    if (typeof rawDefault === "string" && rawDefault !== "") out.default = rawDefault;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "BooleanParameterDefinition") {
    const out: ParameterSpec = { type: "boolean", name: p.name };
    if (typeof rawDefault === "boolean") out.default = rawDefault;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "ChoiceParameterDefinition" && p.choices && p.choices.length > 0) {
    const out: ParameterSpec = { type: "choice", name: p.name, choices: p.choices };
    if (typeof rawDefault === "string") out.default = rawDefault;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "PasswordParameterDefinition") {
    const out: ParameterSpec = { type: "password", name: p.name };
    if (desc) out.description = desc;
    return out;
  }
  if (last === "FileParameterDefinition") {
    const out: ParameterSpec = { type: "file", name: p.name };
    if (desc) out.description = desc;
    return out;
  }
  if (last === "RunParameterDefinition") {
    const out: ParameterSpec = { type: "run", name: p.name };
    if (p.projectName) out.projectName = p.projectName;
    if (desc) out.description = desc;
    return out;
  }
  if (last === "CredentialsParameterDefinition") {
    const out: ParameterSpec = { type: "credentials", name: p.name };
    if (p.credentialType) out.credentialType = p.credentialType;
    if (desc) out.description = desc;
    return out;
  }
  const fallback: ParameterSpec = { type: "unknown", name: p.name, rawType: cls };
  if (desc) fallback.description = desc;
  return fallback;
}
