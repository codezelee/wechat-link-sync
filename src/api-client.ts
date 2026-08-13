import { requestUrl, type RequestUrlParam } from "obsidian";
import type {
  BulkDeleteResult,
  BulkTrashResult,
  CaptureCounts,
  CaptureLease,
  CapturePage,
  CaptureStatus,
  CaptureSummary,
  DevicePlatform,
  ErrorStage,
  RestorableCaptureStatus
} from "./contracts.js";
import { PLUGIN_VERSION, type ArticleInboxSettings, type PendingReport, type UpdateRange } from "./models.js";
import { buildJsonRequest } from "./http-request.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) { super(message); }
}

export class ApiClient {
  constructor(private readonly settings: () => ArticleInboxSettings) {}

  async health(): Promise<{ ok: boolean; protocolVersion: number; serverTime: string }> {
    return this.request("/health", { auth: false });
  }

  async bind(bindingCode: string, deviceName: string, platform: DevicePlatform) {
    return this.request<{ deviceToken: string; device: { id: string; userId: string } }>("/api/v1/plugin/devices/bind", {
      method: "POST",
      auth: false,
      body: { bindingCode, deviceName, platform, pluginVersion: PLUGIN_VERSION }
    });
  }

  async unbind(): Promise<void> { await this.request("/api/v1/plugin/devices/current", { method: "DELETE" }); }
  async renameCurrentDevice(name: string): Promise<void> { await this.request("/api/v1/plugin/devices/current", { method: "PATCH", body: { name } }); }
  async counts(): Promise<CaptureCounts> { return this.request("/api/v1/plugin/captures/counts"); }

  async captures(status: CaptureStatus, range: UpdateRange, limit: number, cursor?: string): Promise<CapturePage> {
    const params = new URLSearchParams({ status, limit: String(limit) });
    if (range !== "all" && status === "pending") params.set("createdWithinDays", range);
    if (cursor) params.set("cursor", cursor);
    return this.request(`/api/v1/plugin/captures?${params}`);
  }

  async capture(id: string): Promise<CaptureSummary> { return this.request(`/api/v1/plugin/captures/${id}`); }
  async claim(id: string): Promise<CaptureLease> { return this.request(`/api/v1/plugin/captures/${id}/claim`, { method: "POST" }); }
  async retry(id: string): Promise<CaptureLease> { return this.request(`/api/v1/plugin/captures/${id}/retry`, { method: "POST" }); }
  async renew(id: string, leaseId: string): Promise<{ leaseExpiresAt: string }> {
    return this.request(`/api/v1/plugin/captures/${id}/renew`, { method: "POST", body: { leaseId } });
  }

  async complete(report: PendingReport): Promise<CaptureSummary> {
    return this.request(`/api/v1/plugin/captures/${report.captureId}/complete`, {
      method: "POST",
      body: {
        leaseId: report.leaseId,
        pluginVersion: PLUGIN_VERSION,
        extractor: report.extractor,
        extractorVersion: report.extractorVersion,
        warnings: report.warnings,
        sourceName: report.sourceName,
        title: report.title,
        author: report.author,
        publishedAt: report.publishedAt,
        coverUrl: report.coverUrl
      }
    });
  }

  async fail(id: string, leaseId: string, stage: ErrorStage, code: string, message: string): Promise<CaptureSummary> {
    return this.request(`/api/v1/plugin/captures/${id}/fail`, {
      method: "POST",
      body: { leaseId, stage, errorCode: code, message, retryable: true, pluginVersion: PLUGIN_VERSION }
    });
  }

  async ignore(id: string): Promise<CaptureSummary> {
    return this.request(`/api/v1/plugin/captures/${id}/ignore`, { method: "POST" });
  }

  async restoreIgnored(id: string): Promise<CaptureSummary> {
    return this.request(`/api/v1/plugin/captures/${id}/restore`, { method: "POST" });
  }

  async trash(id: string): Promise<CaptureSummary> {
    return this.request(`/api/v1/plugin/captures/${id}/trash`, { method: "POST" });
  }

  async trashAll(status: RestorableCaptureStatus): Promise<BulkTrashResult> {
    return this.request("/api/v1/plugin/captures/trash", { method: "POST", body: { status } });
  }

  async restoreTrashed(id: string): Promise<CaptureSummary> {
    return this.request(`/api/v1/plugin/captures/${id}/restore-from-trash`, { method: "POST" });
  }

  async purge(id: string): Promise<BulkDeleteResult> {
    return this.request(`/api/v1/plugin/captures/${id}`, { method: "DELETE" });
  }

  async purgeAll(): Promise<BulkDeleteResult> {
    return this.request("/api/v1/plugin/captures", { method: "DELETE" });
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const settings = this.settings();
    const parameters: RequestUrlParam = buildJsonRequest(`${settings.serverUrl.replace(/\/$/, "")}${path}`, {
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.auth === false ? {} : { authorization: `Bearer ${settings.deviceToken}` })
    });
    const response = await requestUrl(parameters);
    const payload = response.json as { code?: string; message?: string } | undefined;
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(response.status, payload?.code ?? "REQUEST_FAILED", payload?.message ?? `请求失败 (${response.status})`);
    }
    return response.json as T;
  }
}
