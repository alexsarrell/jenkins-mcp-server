import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { mapJenkinsParameter, type JenkinsParameterDefinition } from "./parameter-mapper.js";
import type { ParameterSpec } from "../schemas/parameter.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

export interface JobDescription {
  type: "pipeline" | "multibranch" | "freestyle" | "folder" | "unknown";
  description?: string;
  disabled: boolean;
  concurrentBuilds: boolean;
  scm?: {
    type: "git" | "unknown";
    url?: string;
    branches?: string[];
    credentialsId?: string;
    jenkinsfilePath?: string;
  };
  triggers?: {
    cron?: string;
    scmPolling?: string;
  };
  parameters?: ParameterSpec[];
  buildRetention?: {
    numToKeep?: number;
    daysToKeep?: number;
  };
  unknownXmlElements: string[];
  rawConfigSha: string;
}

const KNOWN_ROOTS: Record<string, JobDescription["type"]> = {
  "flow-definition": "pipeline",
  "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject": "multibranch",
  "com.cloudbees.hudson.plugins.folder.Folder": "folder",
  project: "freestyle",
};

const PIPELINE_KNOWN = new Set(["description", "keepDependencies", "properties", "triggers", "definition", "disabled"]);
const MULTIBRANCH_KNOWN = new Set(["description", "disabled", "sources", "factory", "orphanedItemStrategy", "properties", "triggers"]);
const FREESTYLE_KNOWN = new Set(["description", "disabled", "concurrentBuild", "properties", "triggers"]);

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "#text" in v) return String((v as { "#text": unknown })["#text"]);
  return String(v);
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  const s = asString(v);
  if (s === "true") return true;
  if (s === "false") return false;
  return fallback;
}

function asNumber(v: unknown): number | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function extractParameters(properties: unknown): ParameterSpec[] | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const props = properties as Record<string, unknown>;
  const paramProp = props["hudson.model.ParametersDefinitionProperty"];
  if (!paramProp || typeof paramProp !== "object") return undefined;
  const defsContainer = (paramProp as Record<string, unknown>).parameterDefinitions;
  if (!defsContainer || typeof defsContainer !== "object") return undefined;
  const defs: JenkinsParameterDefinition[] = [];
  for (const [tag, raw] of Object.entries(defsContainer as Record<string, unknown>)) {
    for (const item of asArray(raw)) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const name = asString(obj.name);
      if (!name) continue;
      const description = asString(obj.description);
      const def: JenkinsParameterDefinition = {
        _class: tag,
        name,
        description,
        defaultParameterValue: { value: parseDefaultValue(tag, obj.defaultValue) },
      };
      if (tag === "hudson.model.ChoiceParameterDefinition") {
        const choicesNode = obj.choices as Record<string, unknown> | undefined;
        const stringList = choicesNode && typeof choicesNode === "object"
          ? choicesNode.a as Record<string, unknown> | undefined
          : undefined;
        const stringEntries = stringList && typeof stringList === "object"
          ? asArray(stringList.string).map(asString).filter((s): s is string => typeof s === "string")
          : [];
        def.choices = stringEntries;
      }
      defs.push(def);
    }
  }
  return defs.map(mapJenkinsParameter);
}

function parseDefaultValue(tag: string, raw: unknown): string | boolean | undefined {
  if (raw === undefined) return undefined;
  if (tag === "hudson.model.BooleanParameterDefinition") {
    const s = asString(raw);
    return s === "true";
  }
  return asString(raw);
}

function extractRetention(properties: unknown): JobDescription["buildRetention"] | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const props = properties as Record<string, unknown>;
  const disc = props["jenkins.model.BuildDiscarderProperty"];
  if (!disc || typeof disc !== "object") return undefined;
  const strategy = (disc as Record<string, unknown>).strategy;
  if (!strategy || typeof strategy !== "object") return undefined;
  const s = strategy as Record<string, unknown>;
  const out: JobDescription["buildRetention"] = {};
  const numToKeep = asNumber(s.numToKeep);
  const daysToKeep = asNumber(s.daysToKeep);
  if (numToKeep !== undefined && numToKeep > 0) out.numToKeep = numToKeep;
  if (daysToKeep !== undefined && daysToKeep > 0) out.daysToKeep = daysToKeep;
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractCronTrigger(triggers: unknown): string | undefined {
  if (!triggers || typeof triggers !== "object") return undefined;
  const t = (triggers as Record<string, unknown>)["hudson.triggers.TimerTrigger"];
  if (!t || typeof t !== "object") return undefined;
  return asString((t as Record<string, unknown>).spec);
}

function parsePipelineScm(definition: unknown): JobDescription["scm"] | undefined {
  if (!definition || typeof definition !== "object") return undefined;
  const def = definition as Record<string, unknown>;
  const scm = def.scm;
  const scriptPath = asString(def.scriptPath);
  if (!scm || typeof scm !== "object") {
    return scriptPath ? { type: "unknown", jenkinsfilePath: scriptPath } : undefined;
  }
  const scmCls = (scm as Record<string, unknown>)["@_class"];
  if (scmCls === "hudson.plugins.git.GitSCM") {
    const remote = (scm as Record<string, unknown>).userRemoteConfigs as Record<string, unknown> | undefined;
    const config = remote ? (remote["hudson.plugins.git.UserRemoteConfig"] as Record<string, unknown> | undefined) : undefined;
    const url = config ? asString(config.url) : undefined;
    const credentialsId = config ? asString(config.credentialsId) : undefined;
    const branchesNode = (scm as Record<string, unknown>).branches as Record<string, unknown> | undefined;
    const branches = branchesNode
      ? asArray(branchesNode["hudson.plugins.git.BranchSpec"]).map((b) => asString((b as Record<string, unknown>).name)).filter((b): b is string => !!b)
      : undefined;
    const out: JobDescription["scm"] = { type: "git" };
    if (url) out.url = url;
    if (credentialsId) out.credentialsId = credentialsId;
    if (branches && branches.length > 0) out.branches = branches;
    if (scriptPath) out.jenkinsfilePath = scriptPath;
    return out;
  }
  return scriptPath ? { type: "unknown", jenkinsfilePath: scriptPath } : { type: "unknown" };
}

function parseMultibranchScm(sources: unknown, factory: unknown): JobDescription["scm"] | undefined {
  const factoryScript = factory && typeof factory === "object"
    ? asString((factory as Record<string, unknown>).scriptPath)
    : undefined;
  const data = sources && typeof sources === "object"
    ? (sources as Record<string, unknown>).data
    : undefined;
  const branchSource = data && typeof data === "object"
    ? (data as Record<string, unknown>)["jenkins.branch.BranchSource"] as Record<string, unknown> | undefined
    : undefined;
  const source = branchSource ? branchSource.source as Record<string, unknown> | undefined : undefined;
  if (!source) {
    return factoryScript ? { type: "unknown", jenkinsfilePath: factoryScript } : undefined;
  }
  const sourceCls = source["@_class"];
  const out: JobDescription["scm"] = { type: sourceCls === "jenkins.plugins.git.GitSCMSource" ? "git" : "unknown" };
  const url = asString(source.remote);
  const credentialsId = asString(source.credentialsId);
  if (url) out.url = url;
  if (credentialsId) out.credentialsId = credentialsId;
  if (factoryScript) out.jenkinsfilePath = factoryScript;
  return out;
}

function listUnknownChildren(node: Record<string, unknown>, known: Set<string>): string[] {
  return Object.keys(node).filter((k) => !k.startsWith("@_") && k !== "?xml" && !known.has(k));
}

export function parseJobConfig(xml: string): JobDescription {
  const sha = createHash("sha256").update(xml).digest("hex").slice(0, 12);
  const tree = parser.parse(xml) as Record<string, unknown>;

  const rootEntry = Object.entries(tree).find(([k]) => k !== "?xml");
  const rootName = rootEntry?.[0] ?? "";
  const rootNode = (rootEntry?.[1] as Record<string, unknown>) ?? {};
  const type = KNOWN_ROOTS[rootName] ?? "unknown";

  if (type === "unknown") {
    return { type, disabled: false, concurrentBuilds: false, unknownXmlElements: [rootName], rawConfigSha: sha };
  }

  const description = asString(rootNode.description);
  const disabled = asBoolean(rootNode.disabled, false);
  const concurrentBuilds = type === "freestyle" ? asBoolean(rootNode.concurrentBuild, false) : false;
  const properties = rootNode.properties;
  const parameters = extractParameters(properties);
  const buildRetention = extractRetention(properties);
  const cron = extractCronTrigger(rootNode.triggers);

  let scm: JobDescription["scm"] | undefined;
  let unknownChildren: string[];

  if (type === "pipeline") {
    scm = parsePipelineScm(rootNode.definition);
    unknownChildren = listUnknownChildren(rootNode, PIPELINE_KNOWN);
  } else if (type === "multibranch") {
    scm = parseMultibranchScm(rootNode.sources, rootNode.factory);
    unknownChildren = listUnknownChildren(rootNode, MULTIBRANCH_KNOWN);
  } else if (type === "freestyle") {
    unknownChildren = listUnknownChildren(rootNode, FREESTYLE_KNOWN);
  } else {
    unknownChildren = [];
  }

  const out: JobDescription = {
    type,
    disabled,
    concurrentBuilds,
    unknownXmlElements: unknownChildren,
    rawConfigSha: sha,
  };
  if (description) out.description = description;
  if (scm) out.scm = scm;
  if (cron) out.triggers = { cron };
  if (parameters && parameters.length > 0) out.parameters = parameters;
  if (buildRetention) out.buildRetention = buildRetention;
  return out;
}
