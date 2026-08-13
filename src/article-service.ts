import { requestUrl } from "obsidian";
import type { ErrorStage } from "./contracts.js";
import type { ParsedArticle } from "./models.js";
import { doubanReviewApiUrl, parseDoubanReviewPayload } from "./douban-review.js";
import { parseArticle } from "./parser.js";
import { isSafePublicUrl } from "./path-utils.js";
import { isXiaohongshuNoteUrl, parseXiaohongshuPage } from "./xiaohongshu.js";
import { fetchWeiboArticle } from "./weibo-service.js";
import { weiboStatusId } from "./weibo.js";

export class ProcessingError extends Error {
  constructor(
    public readonly stage: ErrorStage,
    public readonly code: string,
    message: string
  ) { super(message); }
}

export async function fetchAndParse(url: string, timeoutSeconds: number): Promise<ParsedArticle> {
  if (!isSafePublicUrl(url)) throw new ProcessingError("fetch", "UNSAFE_URL", "已阻止本机、内网或非 HTTP 地址");
  if (weiboStatusId(url)) {
    try { return await fetchWeiboArticle(url, timeoutSeconds); }
    catch (error) {
      const message = messageOf(error);
      const stage = message.startsWith("CONTENT_NOT_FOUND") ? "extract" : "fetch";
      throw new ProcessingError(stage, stage === "extract" ? "CONTENT_NOT_FOUND" : "WEIBO_FETCH_FAILED", message.replace(/^[A-Z_]+:\s*/, ""));
    }
  }
  const doubanApiUrl = doubanReviewApiUrl(url);
  const requestTarget = doubanApiUrl ?? url;
  let response;
  try {
    response = await withTimeout(
      requestUrl({
        url: requestTarget,
        method: "GET",
        headers: doubanApiUrl ? doubanHeaders() : { "user-agent": "Mozilla/5.0 WeChatLinkSync/1.0" },
        throw: false
      }),
      timeoutSeconds * 1000
    );
  } catch (error) {
    throw new ProcessingError("fetch", "HTTP_TIMEOUT", messageOf(error));
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ProcessingError("fetch", `HTTP_${response.status}`, `网页请求失败 (${response.status})`);
  }
  if (new TextEncoder().encode(response.text).byteLength > 8 * 1024 * 1024) {
    throw new ProcessingError("fetch", "CONTENT_TOO_LARGE", "网页正文超过 8 MiB 安全上限");
  }
  try {
    if (doubanApiUrl) return parseDoubanReviewPayload(response.json ?? JSON.parse(response.text), url);
    if (isXiaohongshuNoteUrl(url)) return parseXiaohongshuPage(response.text, url);
    return parseArticle(response.text, url);
  } catch (error) {
    const message = messageOf(error);
    const code = message.startsWith("CONTENT_NOT_FOUND") ? "CONTENT_NOT_FOUND" : "UNSUPPORTED_PAGE";
    throw new ProcessingError("extract", code, message.replace(/^[A-Z_]+:\s*/, ""));
  }
}

function doubanHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    referer: "https://m.douban.com/",
    "user-agent": "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/150 Safari/537.36 ArticleInbox/1.1"
  };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error("网页请求超时")), milliseconds);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { window.clearTimeout(timer); }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
