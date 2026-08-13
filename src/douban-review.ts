import type { ParsedArticle } from "./models.js";
import { parseArticle } from "./parser.js";

const DOUBAN_REVIEW_EXTRACTOR_VERSION = "1.0.0";
const REVIEW_ID_PATTERN = /^\d{5,20}$/;

interface DoubanPhoto {
  id?: unknown;
  tag_name?: unknown;
  description?: unknown;
  image?: {
    large?: { url?: unknown };
    normal?: { url?: unknown };
  };
}

interface DoubanReviewPayload {
  id?: unknown;
  title?: unknown;
  abstract?: unknown;
  content?: unknown;
  create_time?: unknown;
  edit_time?: unknown;
  cover_url?: unknown;
  user?: { name?: unknown; avatar?: unknown };
  subject?: { cover_url?: unknown };
  photos?: unknown;
}

export interface DoubanReviewPreview {
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  coverUrl: string | null;
}

export function doubanReviewApiUrl(sourceUrl: string): string | null {
  const reviewId = doubanReviewId(sourceUrl);
  return reviewId
    ? `https://m.douban.com/rexxar/api/v2/review/${reviewId}?ck=&for_mobile=1`
    : null;
}

export function doubanReviewId(sourceUrl: string): string | null {
  let url: URL;
  try { url = new URL(sourceUrl); }
  catch { return null; }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "douban.com" && !hostname.endsWith(".douban.com")) return null;

  const direct = /\/(?:doubanapp\/dispatch\/)?review\/(\d{5,20})(?:\/|$)/.exec(url.pathname)?.[1];
  if (direct && REVIEW_ID_PATTERN.test(direct)) return direct;

  for (const key of ["uri", "fallback", "url"]) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    let decoded = value;
    try { decoded = decodeURIComponent(value); }
    catch { /* URLSearchParams has normally decoded this already. */ }
    const nested = /(?:^|\/)review\/(\d{5,20})(?:\/|$|[?#])/.exec(decoded)?.[1];
    if (nested && REVIEW_ID_PATTERN.test(nested)) return nested;
  }
  return null;
}

export function parseDoubanReviewPayload(payload: unknown, sourceUrl: string): ParsedArticle {
  const review = objectPayload(payload);
  const title = cleanString(review.title);
  const content = cleanString(review.content);
  if (!title || !content) throw new Error("CONTENT_NOT_FOUND: 豆瓣未返回有效影评正文");

  const document = new DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");
  document.title = title;
  appendMeta(document, "author", cleanString(review.user?.name));
  appendMeta(document, "article:published_time", cleanString(review.create_time));
  appendMeta(document, "description", cleanString(review.abstract));

  const article = document.createElement("article");
  article.id = "douban-review-content";
  const fragment = new DOMParser().parseFromString(content, "text/html");
  for (const child of [...fragment.body.childNodes]) article.appendChild(document.importNode(child, true));
  document.body.appendChild(article);
  hydratePhotoUrls(article, photoList(review.photos));

  const canonicalUrl = canonicalDoubanReviewUrl(sourceUrl);
  const parsed = parseArticle(document.documentElement.outerHTML, canonicalUrl);
  return {
    ...parsed,
    title,
    ...(cleanString(review.user?.name) ? { author: cleanString(review.user?.name)! } : {}),
    ...(cleanString(review.create_time) ? { publishedAt: cleanString(review.create_time)! } : {}),
    ...(cleanString(review.abstract) ? { description: cleanString(review.abstract)! } : {}),
    extractor: "douban-review",
    extractorVersion: DOUBAN_REVIEW_EXTRACTOR_VERSION
  };
}

export function doubanReviewPreview(payload: unknown): DoubanReviewPreview {
  const review = objectPayload(payload);
  const photos = photoList(review.photos);
  return {
    title: cleanString(review.title),
    author: cleanString(review.user?.name),
    publishedAt: cleanString(review.create_time),
    coverUrl: firstPublicUrl(
      photoUrl(photos[0]),
      cleanString(review.cover_url),
      cleanString(review.subject?.cover_url),
      cleanString(review.user?.avatar)
    )
  };
}

function objectPayload(payload: unknown): DoubanReviewPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("CONTENT_NOT_FOUND: 豆瓣返回的数据格式无效");
  }
  return payload;
}

function canonicalDoubanReviewUrl(sourceUrl: string): string {
  const reviewId = doubanReviewId(sourceUrl);
  return reviewId ? `https://www.douban.com/review/${reviewId}/` : sourceUrl;
}

function photoList(value: unknown): DoubanPhoto[] {
  return Array.isArray(value)
    ? value.filter((item): item is DoubanPhoto => Boolean(item && typeof item === "object"))
    : [];
}

function hydratePhotoUrls(root: ParentNode, photos: DoubanPhoto[]): void {
  const byTag = new Map<string, DoubanPhoto>();
  for (const photo of photos) {
    const tag = cleanString(photo.tag_name) ?? (cleanString(photo.id) ? `img_${cleanString(photo.id)}` : null);
    if (tag) byTag.set(tag, photo);
  }
  root.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const photo = byTag.get(image.id);
    const url = photoUrl(photo);
    if (!url) {
      image.remove();
      return;
    }
    image.src = url;
    image.alt = cleanString(photo?.description) ?? "豆瓣文章图片";
  });
}

function photoUrl(photo: DoubanPhoto | undefined): string | null {
  return firstPublicUrl(
    cleanString(photo?.image?.large?.url),
    cleanString(photo?.image?.normal?.url)
  );
}

function firstPublicUrl(...values: Array<string | null>): string | null {
  for (const value of values) {
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString();
    } catch { /* Ignore malformed image URLs. */ }
  }
  return null;
}

function appendMeta(document: Document, name: string, value: string | null): void {
  if (!value) return;
  const element = document.createElement("meta");
  if (name.includes(":")) element.setAttribute("property", name);
  else element.setAttribute("name", name);
  element.setAttribute("content", value);
  document.head.appendChild(element);
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
