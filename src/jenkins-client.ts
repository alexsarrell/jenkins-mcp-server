import { buildJenkinsUrl } from "./utils/path-resolver.js";
import type { JenkinsConfig, JenkinsError } from "./types.js";

export class JenkinsClient {
  private config: JenkinsConfig;
  private authHeader: string;
  private crumb: { field: string; value: string } | null = null;

  constructor(config: JenkinsConfig) {
    this.config = {
      ...config,
      url: config.url.replace(/\/+$/, ""),
    };
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.user}:${config.token}`).toString("base64");
  }

  private async fetchCrumb(): Promise<void> {
    try {
      const resp = await fetch(`${this.config.url}/crumbIssuer/api/json`, {
        headers: { Authorization: this.authHeader },
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          crumbRequestField: string;
          crumb: string;
        };
        this.crumb = {
          field: data.crumbRequestField,
          value: data.crumb,
        };
      }
      // If crumb issuer is not available (404), CSRF is disabled — that's fine
    } catch {
      // Crumb fetch failed — proceed without it
    }
  }

  private getHeaders(
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      ...extra,
    };
    if (this.crumb) {
      headers[this.crumb.field] = this.crumb.value;
    }
    return headers;
  }

  private async handleResponse(resp: Response): Promise<unknown> {
    if (resp.ok) {
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("json")) {
        return resp.json();
      }
      return resp.text();
    }
    await this.throwJenkinsError(resp);
  }

  private async throwJenkinsError(resp: Response): Promise<never> {
    let message: string;
    try {
      message = await resp.text();
    } catch {
      message = resp.statusText;
    }

    let errorCode: string;
    switch (resp.status) {
      case 401:
        errorCode = "AUTH_FAILED";
        message =
          "Authentication failed. Check JENKINS_USER and JENKINS_API_TOKEN.";
        break;
      case 403:
        errorCode = "FORBIDDEN";
        message = `Access denied. The user may lack permissions for this operation.`;
        break;
      case 404:
        errorCode = "NOT_FOUND";
        message = `Resource not found. Check that the job path is correct.`;
        break;
      case 500:
        errorCode = "SERVER_ERROR";
        break;
      default:
        errorCode = "HTTP_ERROR";
    }

    const error: JenkinsError = {
      statusCode: resp.status,
      message,
      errorCode,
    };
    throw error;
  }

  async get(
    jobPath: string,
    suffix: string,
    params?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(buildJenkinsUrl(this.config.url, jobPath, suffix));
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const resp = await fetch(url.toString(), {
      headers: this.getHeaders(),
    });
    return this.handleResponse(resp);
  }

  async getRaw(jobPath: string, suffix: string): Promise<string> {
    const url = buildJenkinsUrl(this.config.url, jobPath, suffix);
    const resp = await fetch(url, {
      headers: this.getHeaders(),
    });
    if (!resp.ok) {
      await this.throwJenkinsError(resp);
    }
    return resp.text();
  }

  async getAbsolute(
    path: string,
    params?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${this.config.url}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const resp = await fetch(url.toString(), {
      headers: this.getHeaders(),
    });
    return this.handleResponse(resp);
  }

  async getRawAbsolute(path: string): Promise<string> {
    const url = `${this.config.url}${path}`;
    const resp = await fetch(url, {
      headers: this.getHeaders(),
    });
    if (!resp.ok) {
      await this.throwJenkinsError(resp);
    }
    return resp.text();
  }

  async post(
    jobPath: string,
    suffix: string,
    body?: string,
    contentType?: string,
  ): Promise<{ response: Response; data: unknown }> {
    if (!this.crumb) {
      await this.fetchCrumb();
    }

    const url = buildJenkinsUrl(this.config.url, jobPath, suffix);
    const headers = this.getHeaders(
      contentType ? { "Content-Type": contentType } : {},
    );

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: body ?? undefined,
    });

    // If we get a 403 and have a crumb, try refreshing it
    if (resp.status === 403 && this.crumb) {
      this.crumb = null;
      await this.fetchCrumb();
      const retryHeaders = this.getHeaders(
        contentType ? { "Content-Type": contentType } : {},
      );
      const retryResp = await fetch(url, {
        method: "POST",
        headers: retryHeaders,
        body: body ?? undefined,
      });
      if (!retryResp.ok) {
        await this.throwJenkinsError(retryResp);
      }
      return { response: retryResp, data: await this.safeParseBody(retryResp) };
    }

    if (!resp.ok) {
      await this.throwJenkinsError(resp);
    }
    return { response: resp, data: await this.safeParseBody(resp) };
  }

  async postForm(
    jobPath: string,
    suffix: string,
    formData: URLSearchParams,
  ): Promise<{ response: Response; data: unknown }> {
    return this.post(
      jobPath,
      suffix,
      formData.toString(),
      "application/x-www-form-urlencoded",
    );
  }

  async postAbsolute(
    path: string,
    body?: string,
    contentType?: string,
  ): Promise<{ response: Response; data: unknown }> {
    if (!this.crumb) {
      await this.fetchCrumb();
    }

    const url = `${this.config.url}${path}`;
    const headers = this.getHeaders(
      contentType ? { "Content-Type": contentType } : {},
    );

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: body ?? undefined,
    });

    if (resp.status === 403 && this.crumb) {
      this.crumb = null;
      await this.fetchCrumb();
      const retryHeaders = this.getHeaders(
        contentType ? { "Content-Type": contentType } : {},
      );
      const retryResp = await fetch(url, {
        method: "POST",
        headers: retryHeaders,
        body: body ?? undefined,
      });
      if (!retryResp.ok) {
        await this.throwJenkinsError(retryResp);
      }
      return { response: retryResp, data: await this.safeParseBody(retryResp) };
    }

    if (!resp.ok) {
      await this.throwJenkinsError(resp);
    }
    return { response: resp, data: await this.safeParseBody(resp) };
  }

  private async safeParseBody(resp: Response): Promise<unknown> {
    const contentType = resp.headers.get("content-type") || "";
    try {
      if (contentType.includes("json")) {
        return await resp.json();
      }
      return await resp.text();
    } catch {
      return null;
    }
  }

  get baseUrl(): string {
    return this.config.url;
  }
}
