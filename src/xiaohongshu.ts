import type { ParsedArticle } from "./models.js";

const EXTRACTOR_VERSION = "1.0.0";
const INITIAL_STATE_PREFIX = "window.__INITIAL_STATE__=";
const NOTE_ID_PATTERN = /^[0-9a-f]{24}$/i;

interface XiaohongshuImage {
  url?: unknown;
  urlPre?: unknown;
  urlDefault?: unknown;
  infoList?: Array<{ url?: unknown; imageScene?: unknown }>;
}

interface XiaohongshuNote {
  title?: unknown;
  desc?: unknown;
  time?: unknown;
  lastUpdateTime?: unknown;
  user?: { nickname?: unknown };
  imageList?: unknown;
}

interface XiaohongshuArticleData {
  title: string;
  author: string | null;
  publishedAt: string | null;
  description: string;
  sourceTags: string[];
  images: Array<{ url: string; alt: string }>;
}

export interface XiaohongshuPreview {
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  coverUrl: string | null;
}

export function isXiaohongshuNoteUrl(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.toLowerCase();
    if (host !== "xiaohongshu.com" && !host.endsWith(".xiaohongshu.com")) return false;
    return Boolean(xiaohongshuNoteId(sourceUrl));
  } catch { return false; }
}

export function parseXiaohongshuPage(html: string, sourceUrl: string): ParsedArticle {
  const data = extractArticleData(html, sourceUrl);
  if (!data.title || visibleLength(data.description) < 20) {
    throw new Error("CONTENT_NOT_FOUND: 小红书未返回有效笔记正文");
  }
  const body = formatDescription(data.description);
  const imageMarkdown = data.images.map((image) => `![${image.alt}](${image.url})`).join("\n\n");
  const markdown = [imageMarkdown, body].filter(Boolean).join("\n\n").trim();
  return {
    title: data.title,
    ...(data.author ? { author: data.author } : {}),
    ...(data.publishedAt ? { publishedAt: data.publishedAt } : {}),
    ...(summary(data.description) ? { description: summary(data.description)! } : {}),
    markdown,
    images: data.images,
    sourceTags: data.sourceTags,
    extractor: "xiaohongshu-note",
    extractorVersion: EXTRACTOR_VERSION
  };
}

export function xiaohongshuPreview(html: string, sourceUrl: string): XiaohongshuPreview {
  try {
    const data = extractArticleData(html, sourceUrl);
    return {
      title: data.title || null,
      author: data.author,
      publishedAt: data.publishedAt,
      coverUrl: data.images[0]?.url ?? null
    };
  } catch {
    return { title: null, author: null, publishedAt: null, coverUrl: null };
  }
}

function extractArticleData(html: string, sourceUrl: string): XiaohongshuArticleData {
  const document = new DOMParser().parseFromString(html, "text/html");
  const noteId = xiaohongshuNoteId(sourceUrl);
  const note = initialStateNote(document, noteId);
  const structured = structuredArticle(document);
  const title = cleanTitle(
    cleanString(note?.title)
      ?? text(document.querySelector("#detail-title"))
      ?? cleanString(structured?.headline)
      ?? document.title
  );
  const rawDescription = cleanMultiline(note?.desc)
    ?? text(document.querySelector("#detail-desc .note-text, #detail-desc"), true)
    ?? cleanString(structured?.description)
    ?? "";
  const separated = separateTopics(rawDescription);
  const images = noteImages(note?.imageList);
  if (!images.length) images.push(...structuredImages(structured?.image));
  return {
    title,
    author: cleanString(note?.user?.nickname)
      ?? text(document.querySelector(".author-container .username, .author-wrapper .username, .username"))
      ?? cleanString(authorName(structured?.author)),
    publishedAt: timestamp(note?.time ?? note?.lastUpdateTime)
      ?? cleanString(structured?.datePublished),
    description: separated.description,
    sourceTags: separated.tags,
    images
  };
}

function initialStateNote(document: Document, noteId: string | null): XiaohongshuNote | null {
  const script = [...document.querySelectorAll("script")]
    .map((item) => item.textContent?.trim() ?? "")
    .find((content) => content.startsWith(INITIAL_STATE_PREFIX));
  if (!script) return null;
  try {
    const state = JSON.parse(replaceBareUndefined(script.slice(INITIAL_STATE_PREFIX.length))) as {
      note?: { noteDetailMap?: Record<string, { note?: XiaohongshuNote }> };
    };
    const map = state.note?.noteDetailMap;
    if (!map) return null;
    if (noteId && map[noteId]?.note) return map[noteId].note;
    return Object.values(map).find((item) => item?.note)?.note ?? null;
  } catch { return null; }
}

function structuredArticle(document: Document): Record<string, unknown> | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      const value = JSON.parse(script.textContent ?? "") as unknown;
      const candidates: unknown[] = Array.isArray(value) ? value : [value];
      const article = candidates.find(isStructuredArticle);
      if (article) return article;
    } catch { /* Continue to the rendered-DOM fallback. */ }
  }
  return null;
}

function replaceBareUndefined(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (input.startsWith("undefined", index)
      && !/[A-Za-z0-9_$]/.test(input[index - 1] ?? "")
      && !/[A-Za-z0-9_$]/.test(input[index + 9] ?? "")) {
      output += "null";
      index += 8;
      continue;
    }
    output += character;
  }
  return output;
}

function separateTopics(value: string): { description: string; tags: string[] } {
  const tags: string[] = [];
  const description = value.replace(/#([^#\n]+?)\[话题\]#/g, (_match, topic: string) => {
    const cleaned = cleanTag(topic);
    if (cleaned && !tags.includes(cleaned)) tags.push(cleaned);
    return "";
  }).replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return { description, tags };
}

function formatDescription(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/\s+/g, " ").trim());
  const blocks: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const numbered = /^([0-9]\ufe0f?\u20e3)\s*(.+)$/.exec(line);
    if (numbered) {
      blocks.push(`## ${numbered[1]} ${numbered[2]}`);
      continue;
    }
    const postscript = /^p\.?s\.?\s*[.:：]?\s*(.+)$/i.exec(line);
    if (postscript) {
      blocks.push(`> **PS：** ${postscript[1]}`);
      continue;
    }
    blocks.push(line);
  }
  return blocks.join("\n\n");
}

function noteImages(value: unknown): Array<{ url: string; alt: string }> {
  if (!Array.isArray(value)) return [];
  const urls = value.map((item) => imageUrl(item as XiaohongshuImage)).filter((item): item is string => Boolean(item));
  return [...new Set(urls)].map((url, index) => ({ url, alt: `小红书配图 ${index + 1}` }));
}

function imageUrl(image: XiaohongshuImage): string | null {
  const defaultScene = image.infoList?.find((item) => item.imageScene === "WB_DFT")?.url;
  return publicHttpsUrl(defaultScene)
    ?? publicHttpsUrl(image.urlDefault)
    ?? publicHttpsUrl(image.url)
    ?? publicHttpsUrl(image.urlPre);
}

function structuredImages(value: unknown): Array<{ url: string; alt: string }> {
  const values = Array.isArray(value) ? value : [value];
  const urls = values.map(publicHttpsUrl).filter((item): item is string => Boolean(item));
  return [...new Set(urls)].map((url, index) => ({ url, alt: `小红书配图 ${index + 1}` }));
}

function publicHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.startsWith("data:")) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch { return null; }
}

function xiaohongshuNoteId(sourceUrl: string): string | null {
  try {
    const match = /\/(?:discovery\/item|explore)\/([0-9a-f]{24})(?:\/|$)/i.exec(new URL(sourceUrl).pathname)?.[1];
    return match && NOTE_ID_PATTERN.test(match) ? match : null;
  } catch { return null; }
}

function timestamp(value: unknown): string | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{10,13}$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summary(value: string): string | null {
  const line = value.split("\n").map((item) => item.trim()).find(Boolean);
  return line ? [...line].slice(0, 240).join("") : null;
}

function cleanTitle(value: string | null): string {
  return (value ?? "小红书笔记").replace(/\s*[-–—]\s*小红书\s*$/i, "").replace(/\s+/g, " ").trim();
}

function cleanMultiline(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\r\n?/g, "\n").trim() : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null;
}

function cleanTag(value: string): string | null {
  const tag = value.replaceAll("[", "").replaceAll("]", "").replaceAll("#", "").replace(/\s+/g, " ").trim();
  return tag ? [...tag].slice(0, 60).join("") : null;
}

function isStructuredArticle(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("@type" in value)) return false;
  const type = value["@type"];
  return typeof type === "string" && ["Article", "SocialMediaPosting"].includes(type);
}

function text(element: Element | null, preserveLines = false): string | null {
  const value = element?.textContent;
  return preserveLines ? cleanMultiline(value) : cleanString(value);
}

function authorName(value: unknown): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>).name : null;
}

function visibleLength(value: string): number { return value.replace(/\s/g, "").length; }
