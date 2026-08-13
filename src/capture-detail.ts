import type { CaptureSummary } from "./contracts.js";
import type { CapturePresentation } from "./capture-presentation.js";

export interface CaptureDetailRow {
  label: string;
  value: string;
  error?: boolean;
}

export function captureDetailRows(
  capture: CaptureSummary,
  presentation: CapturePresentation
): CaptureDetailRow[] {
  const rows: CaptureDetailRow[] = [
    { label: "来源", value: `${presentation.sourceName} · ${presentation.sourceHost}` },
    { label: "作者", value: presentation.author },
    { label: "发布时间", value: presentation.publishedAt ? formatCaptureTime(presentation.publishedAt) : "尚未解析" },
    { label: "采集时间", value: formatCaptureTime(capture.createdAt) },
    { label: "更新时间", value: formatCaptureTime(capture.updatedAt) }
  ];
  if (capture.trashedAt) rows.push({ label: "移入回收箱", value: formatCaptureTime(capture.trashedAt) });
  if (capture.claimedByDeviceName) rows.push({ label: "处理设备", value: capture.claimedByDeviceName });
  if (capture.processedByDeviceName) rows.push({ label: "完成设备", value: capture.processedByDeviceName });
  if (presentation.writtenPath) rows.push({ label: "本地文件", value: presentation.writtenPath });
  if (capture.lastErrorMessage) rows.push({ label: "失败原因", value: capture.lastErrorMessage, error: true });
  if (capture.note) rows.push({ label: "采集备注", value: capture.note });
  return rows;
}

export function captureDetailText(
  capture: CaptureSummary,
  presentation: CapturePresentation,
  statusLabel: string
): string {
  const rows = [
    { label: "状态", value: statusLabel },
    { label: "标题", value: presentation.title },
    ...captureDetailRows(capture, presentation),
    { label: "链接", value: capture.originalUrl }
  ];
  return rows.map((row) => `${row.label}：${row.value}`).join("\n");
}

export function formatCaptureTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
