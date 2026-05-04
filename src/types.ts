export interface JenkinsConfig {
  url: string;
  user: string;
  token: string;
}

export interface JenkinsJob {
  _class: string;
  name: string;
  url: string;
  color: string;
  description: string | null;
  fullName: string;
  buildable?: boolean;
  healthReport?: Array<{ description: string; score: number }>;
  lastBuild?: { number: number; result: string | null; timestamp: number; url: string };
  lastSuccessfulBuild?: { number: number; url: string };
  lastFailedBuild?: { number: number; url: string };
  jobs?: JenkinsJob[];
  property?: Array<{
    _class: string;
    parameterDefinitions?: Array<{
      name: string;
      type: string;
      description: string;
      defaultParameterValue?: { value: string };
    }>;
  }>;
}

export interface JenkinsBuild {
  _class: string;
  number: number;
  url: string;
  result: string | null;
  building: boolean;
  duration: number;
  estimatedDuration: number;
  timestamp: number;
  displayName: string;
  description: string | null;
  fullDisplayName: string;
  actions?: Array<{
    _class: string;
    causes?: Array<{ shortDescription: string; userName?: string }>;
    parameters?: Array<{ _class?: string; name: string; value?: string | boolean | number }>;
  }>;
  artifacts?: BuildArtifact[];
  changeSets?: Array<{
    items: Array<{
      msg: string;
      author: { fullName: string };
      commitId: string;
    }>;
  }>;
}

export interface BuildArtifact {
  displayPath: string;
  fileName: string;
  relativePath: string;
}

export interface PipelineStage {
  id: string;
  name: string;
  status: string;
  startTimeMillis: number;
  durationMillis: number;
  pauseDurationMillis: number;
  stageFlowNodes?: Array<{ id: string; name: string; status: { result: string } }>;
}

export interface PipelineRun {
  id: string;
  name: string;
  status: string;
  startTimeMillis: number;
  durationMillis: number;
  stages: PipelineStage[];
}

export interface TestResult {
  failCount: number;
  passCount: number;
  skipCount: number;
  totalCount: number;
  suites?: Array<{
    name: string;
    cases: Array<{
      className: string;
      name: string;
      status: string;
      duration: number;
      errorDetails?: string;
      errorStackTrace?: string;
    }>;
  }>;
}

export interface QueueItem {
  id: number;
  task: { name: string; url: string };
  why: string | null;
  buildableStartMilliseconds: number;
  stuck: boolean;
  blocked: boolean;
}

export interface JenkinsError {
  statusCode: number;
  message: string;
  errorCode: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
