import type { CaptureCounts, CaptureLease, CaptureStatus, CaptureSummary } from "./contracts.js";

declare const __WECHAT_LINK_SYNC_DEFAULT_SERVER_URL__: string;

export const PLUGIN_VERSION = "1.7.2";
export type UpdateRange = "all" | "3" | "7";
export type NoteLocation = "callout" | "frontmatter";
export type InboxTab = CaptureStatus;

export interface PendingReport {
  captureId: string;
  leaseId: string;
  writtenPath: string;
  extractor: string;
  extractorVersion: string;
  warnings: string[];
  sourceName?: string | null;
  title?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  coverUrl?: string | null;
}

export interface LocalCaptureRecord {
  captureId: string;
  originalUrl: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  coverUrl?: string | null;
  writtenPath: string;
  savedAt: string;
}

export interface CapturePreviewRecord {
  captureId: string;
  captureUpdatedAt: string;
  parserVersion?: number;
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  coverUrl: string | null;
  fetchedAt: string;
  errorMessage: string | null;
}

export interface IgnoredCaptureRecord {
  capture: CaptureSummary;
  ignoredAt: string;
}

export interface CaptureListCacheRecord {
  tab: CaptureStatus;
  captures: CaptureSummary[];
  revision: number;
  fetchedAt: string;
}

export interface ArticleInboxSettings {
  serverUrl: string;
  /** Runtime only. saveSettings() must never persist this value. */
  deviceToken: string;
  deviceTokenSecretId: string;
  deviceId: string;
  deviceName: string;
  boundAccount: string;
  autoConnect: boolean;
  openReport: boolean;
  fetchTimeoutSeconds: number;
  articleDirectory: string;
  filenameRule: "safe-title";
  noteLocation: NoteLocation;
  showStatusBar: boolean;
  showPendingCount: boolean;
  showFailures: boolean;
  completionFlash: boolean;
  reduceMotion: boolean;
  pendingReports: PendingReport[];
  captureRecords: LocalCaptureRecord[];
  capturePreviews: CapturePreviewRecord[];
  ignoredCaptures: IgnoredCaptureRecord[];
  captureListCaches: CaptureListCacheRecord[];
}

export const DEFAULT_SETTINGS: ArticleInboxSettings = {
  serverUrl: typeof __WECHAT_LINK_SYNC_DEFAULT_SERVER_URL__ === "undefined"
    ? "https://api.bigpro.cn"
    : __WECHAT_LINK_SYNC_DEFAULT_SERVER_URL__,
  deviceToken: "",
  deviceTokenSecretId: "wechat-link-sync-device-token",
  deviceId: "",
  deviceName: "Obsidian Desktop",
  boundAccount: "",
  autoConnect: true,
  openReport: true,
  fetchTimeoutSeconds: 30,
  articleDirectory: "00-同步链接",
  filenameRule: "safe-title",
  noteLocation: "callout",
  showStatusBar: true,
  showPendingCount: true,
  showFailures: true,
  completionFlash: true,
  reduceMotion: false,
  pendingReports: [],
  captureRecords: [],
  capturePreviews: [],
  ignoredCaptures: [],
  captureListCaches: []
};

export interface ParsedArticle {
  title: string;
  author?: string;
  publishedAt?: string;
  description?: string;
  markdown: string;
  images: Array<{ url: string; alt: string }>;
  sourceTags?: string[];
  extractor: "wechat-defuddle" | "generic-defuddle" | "douban-review" | "xiaohongshu-note" | "weibo-status";
  extractorVersion: string;
}

export interface BatchReport {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  startedAt: number;
  finishedAt: number;
}

export interface InboxState {
  counts: CaptureCounts;
  connection: "unbound" | "connecting" | "connected" | "disconnected";
  processing: boolean;
  progressCurrent: number;
  progressTotal: number;
  captures: CaptureSummary[];
  activeTab: InboxTab;
  listLoading: boolean;
  listLoadingMore: boolean;
  listNextCursor: string | null;
  listHasMore: boolean;
  report?: BatchReport;
}

export type { CaptureCounts, CaptureLease, CaptureSummary };
