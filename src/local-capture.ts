import type { CaptureSummary } from "./contracts.js";
import { isSafePublicUrl } from "./path-utils.js";

export function normalizeLocalArticleUrl(input: string): string {
  const value = input.trim();
  if (!isSafePublicUrl(value)) throw new Error("请输入公开可访问的 HTTP 或 HTTPS 文章链接");
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

export function createLocalCaptureSummary(
  originalUrl: string,
  id: string,
  createdAt = new Date().toISOString()
): CaptureSummary {
  return {
    id,
    originalUrl,
    note: null,
    tags: [],
    status: "processed",
    createdAt,
    updatedAt: createdAt,
    attemptCount: 1,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorStage: null,
    processedAt: createdAt,
    processedByDeviceName: null,
    claimedByDeviceName: null
  };
}

export function createLocalCaptureId(): string {
  return `local-${window.crypto.randomUUID()}`;
}
