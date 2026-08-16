import { isSafePublicUrl } from "./path-utils.js";
import { extractPublishedAt } from "./published-at.js";

export const ARTICLE_PREVIEW_PARSER_VERSION = 2;

export interface ArticlePreview {
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  coverUrl: string | null;
}

export function parseArticlePreview(html: string, sourceUrl: string): ArticlePreview {
  const document = new DOMParser().parseFromString(html, "text/html");
  const title = firstText(
    text(document.querySelector("#activity-name")),
    meta(document, "og:title"),
    meta(document, "twitter:title"),
    document.title
  );
  const author = firstText(
    text(document.querySelector("#js_name")),
    meta(document, "author"),
    meta(document, "article:author")
  );
  const publishedAt = extractPublishedAt(document);
  const image = firstText(
    meta(document, "og:image"),
    meta(document, "twitter:image"),
    imageUrl(document.querySelector("#js_content img[data-src], #js_content img[src], article img[data-src], article img[src], main img[data-src], main img[src]"))
  );
  const coverUrl = absolutePublicUrl(image, sourceUrl);
  return { title, author, publishedAt, coverUrl };
}

function meta(document: Document, key: string): string | null {
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, "\\$&");
  return document.querySelector<HTMLMetaElement>(`meta[property="${escaped}"], meta[name="${escaped}"]`)?.content ?? null;
}

function imageUrl(element: Element | null): string | null {
  if (!(element instanceof HTMLImageElement)) return null;
  return element.dataset.src ?? element.getAttribute("data-src") ?? element.src ?? element.getAttribute("src");
}

function text(element: Element | null): string | null { return element?.textContent ?? null; }

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const cleaned = value?.replace(/\s+/g, " ").trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function absolutePublicUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  try {
    const result = new URL(value, base).toString();
    return isSafePublicUrl(result) ? result : null;
  } catch { return null; }
}
