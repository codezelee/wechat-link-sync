import type { CaptureSummary } from "./contracts.js";
import type { CapturePreviewRecord, InboxTab, LocalCaptureRecord } from "./models.js";

export interface CapturePresentation {
  sourceName: string;
  sourceHost: string;
  title: string;
  author: string;
  publishedAt: string | null;
  primaryTime: string;
  primaryTimeKind: "发布" | "采集" | "处理" | "清除";
  coverUrl: string | null;
  writtenPath: string | null;
}

export const CAPTURE_TAB_ORDER: InboxTab[] = ["pending", "failed", "processing", "processed", "ignored", "trashed"];

export const CAPTURE_TAB_ICON: Record<InboxTab, string> = {
  pending: "inbox",
  failed: "triangle-alert",
  processing: "loader-circle",
  processed: "check-circle-2",
  ignored: "archive-x",
  trashed: "trash-2"
};

export const CAPTURE_STATUS_LABEL: Record<InboxTab, string> = {
  pending: "未处理",
  failed: "处理失败",
  processing: "处理中",
  processed: "已处理",
  ignored: "不处理",
  trashed: "回收箱"
};

export function buildCapturePresentation(
  capture: CaptureSummary,
  local?: LocalCaptureRecord,
  preview?: CapturePreviewRecord
): CapturePresentation {
  const publishedAt = clean(capture.publishedAt) ?? clean(local?.publishedAt) ?? clean(preview?.publishedAt) ?? null;
  const processedAt = clean(capture.processedAt);
  const trashedAt = clean(capture.trashedAt);
  const primaryTime = capture.status === "trashed" && trashedAt
    ? trashedAt
    : publishedAt ?? (capture.status === "processed" ? processedAt : null) ?? capture.createdAt;
  const primaryTimeKind = capture.status === "trashed" && trashedAt
    ? "清除"
    : publishedAt ? "发布" : capture.status === "processed" && processedAt ? "处理" : "采集";
  return {
    sourceName: clean(capture.sourceName) ?? sourceName(capture.originalUrl),
    sourceHost: host(capture.originalUrl),
    title: clean(capture.title) ?? clean(local?.title) ?? clean(preview?.title) ?? clean(capture.note)
      ?? (preview?.errorMessage ? "文章标题读取失败" : "正在读取文章标题…"),
    author: clean(capture.author) ?? clean(local?.author) ?? clean(preview?.author)
      ?? (preview?.errorMessage ? "作者未提供" : "正在读取作者…"),
    publishedAt,
    primaryTime,
    primaryTimeKind,
    coverUrl: clean(capture.coverUrl) ?? clean(local?.coverUrl) ?? clean(preview?.coverUrl) ?? null,
    writtenPath: clean(local?.writtenPath) ?? null
  };
}

export function sourceName(url: string): string {
  const domain = host(url).toLowerCase();
  if (domain === "mp.weixin.qq.com") return "微信公众号";
  if (domain === "zhuanlan.zhihu.com" || domain === "zhihu.com") return "知乎";
  if (domain === "juejin.cn") return "掘金";
  if (domain === "bilibili.com" || domain.endsWith(".bilibili.com")) return "哔哩哔哩";
  if (domain === "weibo.com" || domain.endsWith(".weibo.com")
    || domain === "weibo.cn" || domain.endsWith(".weibo.cn")) return "微博";
  if (domain === "xiaohongshu.com" || domain.endsWith(".xiaohongshu.com")) return "小红书";
  if (domain === "douban.com" || domain.endsWith(".douban.com")) return "豆瓣";
  return domain || "网页";
}

export function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function clean(value: string | null | undefined): string | null {
  const result = value?.replace(/\s+/g, " ").trim();
  return result ? result : null;
}
