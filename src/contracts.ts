/**
 * Minimal public protocol types used by the Obsidian client.
 *
 * Server implementation, storage schemas, deployment configuration, and the
 * WeChat Mini Program are intentionally not part of this repository.
 */
export const PROTOCOL_VERSION = 2 as const;

export type CaptureStatus = "pending" | "processing" | "processed" | "failed" | "ignored" | "trashed";
export type RestorableCaptureStatus = Exclude<CaptureStatus, "processing" | "trashed">;
export type DevicePlatform = "windows" | "macos";
export type ErrorStage = "fetch" | "extract" | "assets" | "write" | "report";

export interface CaptureCounts {
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  processedCount: number;
  ignoredCount: number;
  trashedCount: number;
  revision: number;
}

export interface CaptureSummary {
  id: string;
  originalUrl: string;
  sourceName?: string | null;
  title?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  coverUrl?: string | null;
  note: string | null;
  tags: string[];
  status: CaptureStatus;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorStage: ErrorStage | null;
  processedAt: string | null;
  processedByDeviceName: string | null;
  claimedByDeviceName: string | null;
  trashedAt?: string | null;
  trashedFromStatus?: RestorableCaptureStatus | null;
}

export interface CaptureLease extends CaptureSummary {
  leaseId: string;
  leaseExpiresAt: string;
}

export interface CapturePage {
  items: CaptureSummary[];
  nextCursor: string | null;
}

export interface CaptureChange {
  revision: number;
  captureId: string;
  fromStatus: CaptureStatus | null;
  toStatus: CaptureStatus;
  occurredAt: string;
  capture: CaptureSummary;
}

export interface CaptureRemoval {
  revision: number;
  captureIds: string[];
  occurredAt: string;
}

export interface BulkTrashResult {
  items: CaptureSummary[];
  movedCount: number;
  skippedProcessingCount: number;
}

export interface BulkDeleteResult {
  captureIds: string[];
  deletedCount: number;
}

export type ServerEvent =
  | { type: "auth.ok"; requestId: string; payload: { connectionId: string; serverTime: string } }
  | { type: "capture.changed"; eventId: string; occurredAt: string; payload: CaptureChange & { counts: CaptureCounts } }
  | { type: "captures.removed"; eventId: string; occurredAt: string; payload: CaptureRemoval & { counts: CaptureCounts } }
  | { type: "error"; requestId?: string; payload: { code: string; message: string } };
