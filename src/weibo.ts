import type { ParsedArticle } from "./models.js";

const EXTRACTOR_VERSION = "1.0.0";

interface WeiboImageVariant { url?: unknown }
interface WeiboPicture {
  largest?: WeiboImageVariant;
  original?: WeiboImageVariant;
  large?: WeiboImageVariant;
  bmiddle?: WeiboImageVariant;
  url?: unknown;
}

interface WeiboStatus {
  id?: unknown;
  idstr?: unknown;
  mid?: unknown;
  mblogid?: unknown;
  created_at?: unknown;
  text?: unknown;
  text_raw?: unknown;
  isLongText?: unknown;
  user?: { screen_name?: unknown };
  title?: unknown;
  pic_infos?: unknown;
  pics?: unknown;
  topic_struct?: unknown;
}

export interface WeiboPreview {
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  coverUrl: string | null;
}

export interface WeiboVisitorSession {
  sub: string;
  subp: string;
}

export function weiboStatusId(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "weibo.com" && !host.endsWith(".weibo.com")
      && host !== "weibo.cn" && !host.endsWith(".weibo.cn")) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const candidate = segments[segments.length - 1]!;
    return /^[A-Za-z0-9]{5,24}$/.test(candidate) ? candidate : null;
  } catch { return null; }
}

export function parseWeiboVisitorPayload(text: string): WeiboVisitorSession {
  const match = /visitor_gray_callback\((\{[\s\S]*\})\)\s*;?/.exec(text);
  if (!match) throw new Error("微博访客会话返回格式无效");
  const payload = JSON.parse(match[1]!) as { retcode?: number; data?: { sub?: unknown; subp?: unknown } };
  const sub = cleanString(payload.data?.sub);
  const subp = cleanString(payload.data?.subp);
  if (payload.retcode !== 20000000 || !sub || !subp) throw new Error("微博访客会话获取失败");
  return { sub, subp };
}

export function parseWeiboStatusPayload(
  statusPayload: unknown,
  longTextPayload: unknown,
  sourceUrl: string
): ParsedArticle {
  const status = objectStatus(statusPayload);
  const longText = extractLongText(longTextPayload);
  const raw = longText ?? cleanString(status.text_raw) ?? htmlText(cleanString(status.text));
  if (!raw || visibleLength(raw) < 20) throw new Error("CONTENT_NOT_FOUND: 微博未返回有效正文");

  const normalized = normalizeWeiboText(raw);
  const content = stripTrailingTopics(normalized);
  const explicitTitle = meaningfulTitle(typeof status.title === "object" && status.title
    ? cleanString((status.title as { text?: unknown }).text)
    : cleanString(status.title));
  const inferred = inferTitle(content);
  const title = explicitTitle ?? inferred.title;
  const body = formatWeiboBody(inferred.body);
  if (visibleLength(body) < 20) throw new Error("CONTENT_NOT_FOUND: 微博正文为空");
  const images = statusImages(status);

  return {
    title: title || `${cleanString(status.user?.screen_name) ?? "微博用户"}的微博`,
    ...(cleanString(status.user?.screen_name) ? { author: cleanString(status.user?.screen_name)! } : {}),
    ...(weiboTimestamp(status.created_at) ? { publishedAt: weiboTimestamp(status.created_at)! } : {}),
    ...(summary(body) ? { description: summary(body)! } : {}),
    markdown: [body, ...images.map((image) => `![${image.alt}](${image.url})`)].join("\n\n"),
    images,
    sourceTags: [...new Set([...statusTopics(status), ...longTextTopics(longTextPayload)])],
    extractor: "weibo-status",
    extractorVersion: EXTRACTOR_VERSION
  };
}

export function weiboPreviewFromStatus(statusPayload: unknown, sourceUrl: string): WeiboPreview {
  const article = parseWeiboStatusPayload(statusPayload, null, sourceUrl);
  return {
    title: article.title,
    author: article.author ?? null,
    publishedAt: article.publishedAt ?? null,
    coverUrl: article.images[0]?.url ?? null
  };
}

export function weiboStatusIsLong(statusPayload: unknown): boolean {
  const status = objectStatus(statusPayload);
  return status.isLongText === true || /class=["']expand["']/.test(cleanString(status.text) ?? "");
}

function objectStatus(payload: unknown): WeiboStatus {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const candidate = root?.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data
    : root;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("CONTENT_NOT_FOUND: 微博状态数据格式无效");
  }
  return candidate;
}

function extractLongText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
  const nested = data.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data as Record<string, unknown>
    : data;
  return cleanString(nested.longTextContent) ?? cleanString(nested.longTextContent_raw);
}

function normalizeWeiboText(value: string): string {
  const document = new DOMParser().parseFromString(`<main>${value}</main>`, "text/html");
  const root = document.querySelector("main")!;
  root.querySelectorAll("script, style, .expand").forEach((item) => item.remove());
  root.querySelectorAll("br").forEach((item) => item.replaceWith(document.createTextNode("\n")));
  root.querySelectorAll("p, div").forEach((item) => item.append(document.createTextNode("\n")));
  return (root.textContent ?? value)
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlText(value: string | null): string | null {
  return value ? normalizeWeiboText(value) : null;
}

function inferTitle(value: string): { title: string; body: string } {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const second = lines[1] ?? "";
  const firstLooksLikeTitle = [...first].length <= 120
    && !numberedLine(first)
    && (Boolean(numberedLine(second)) || /[：:，,！!？?]$/.test(first) || lines.length > 3);
  return firstLooksLikeTitle
    ? { title: first.replace(/[。；;]$/, ""), body: value.slice(value.indexOf(first) + first.length).trim() }
    : { title: [...first].slice(0, 60).join(""), body: value };
}

function formatWeiboBody(value: string): string {
  const lines = value.split("\n").map((line) => line.trim());
  const blocks: string[] = [];
  let currentItem: { number: number; text: string } | null = null;
  const flush = () => {
    if (!currentItem) return;
    blocks.push(`${currentItem.number}. ${currentItem.text.trim()}`);
    currentItem = null;
  };
  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    const item = numberedLine(line);
    if (item) {
      flush();
      currentItem = item;
      continue;
    }
    if (currentItem) {
      currentItem.text += /[。！？；：.!?;:]$/.test(currentItem.text) ? ` ${line}` : line;
      continue;
    }
    blocks.push(line);
  }
  flush();
  return blocks.join("\n\n")
    .replace(/(?:^|\n)展开(?:全文)?(?:\n|$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function numberedLine(value: string): { number: number; text: string } | null {
  const match = /^(\d{1,3})(?:[.．、]\s*|\s+)(.+)$/.exec(value)
    ?? /^(\d{2})([\u3400-\u9fff].+)$/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 && number <= 999 ? { number, text: match[2]!.trim() } : null;
}

function statusImages(status: WeiboStatus): Array<{ url: string; alt: string }> {
  const pictures: WeiboPicture[] = [];
  if (status.pic_infos && typeof status.pic_infos === "object" && !Array.isArray(status.pic_infos)) {
    pictures.push(...Object.values(status.pic_infos as Record<string, WeiboPicture>));
  }
  if (Array.isArray(status.pics)) pictures.push(...status.pics.filter((item): item is WeiboPicture => Boolean(item && typeof item === "object")));
  const urls = pictures.map((picture) => publicImageUrl(
    picture.largest?.url,
    picture.original?.url,
    picture.large?.url,
    picture.bmiddle?.url,
    picture.url
  )).filter((item): item is string => Boolean(item));
  return [...new Set(urls)].map((url, index) => ({ url, alt: `微博配图 ${index + 1}` }));
}

function statusTopics(status: WeiboStatus): string[] {
  if (!Array.isArray(status.topic_struct)) return [];
  const topics = status.topic_struct.map((item) => item && typeof item === "object"
    ? cleanString((item as Record<string, unknown>).topic_title)
    : null).filter((item): item is string => Boolean(item));
  return [...new Set(topics)];
}

function longTextTopics(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const root = payload as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
  if (!Array.isArray(data.topic_struct)) return [];
  return data.topic_struct.map((item) => item && typeof item === "object"
    ? cleanString((item as Record<string, unknown>).topic_title)
    : null).filter((item): item is string => Boolean(item));
}

function publicImageUrl(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === "http:") url.protocol = "https:";
      if (url.protocol === "https:") return url.toString();
    } catch { /* Try the next image variant. */ }
  }
  return null;
}

function weiboTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function summary(value: string): string | null {
  const plain = value.replace(/^\d+\.\s+/gm, "").replace(/\s+/g, " ").trim();
  return plain ? [...plain].slice(0, 240).join("") : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function meaningfulTitle(value: string | null): string | null {
  return value && !["公开", "好友圈", "仅自己可见", "置顶"].includes(value) ? value : null;
}

function stripTrailingTopics(value: string): string {
  const stripped = value.replace(/(?:#[^#\n]+?#\s*)+$/u, "").trim();
  return stripped || value;
}

function visibleLength(value: string): number { return value.replace(/\s/g, "").length; }
