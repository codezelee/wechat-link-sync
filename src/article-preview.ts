import { requestUrl } from "obsidian";
import { doubanReviewApiUrl, doubanReviewPreview } from "./douban-review.js";
import { isSafePublicUrl } from "./path-utils.js";
import { parseArticlePreview, type ArticlePreview } from "./article-preview-parser.js";
import { isXiaohongshuNoteUrl, xiaohongshuPreview } from "./xiaohongshu.js";
import { fetchWeiboPreview } from "./weibo-service.js";
import { weiboStatusId } from "./weibo.js";

export type { ArticlePreview } from "./article-preview-parser.js";

const MAX_PREVIEW_HTML_BYTES = 8 * 1024 * 1024;

export async function fetchArticlePreview(url: string, timeoutSeconds: number): Promise<ArticlePreview> {
  if (!isSafePublicUrl(url)) throw new Error("已阻止本机、内网或非 HTTP 地址");
  if (weiboStatusId(url)) return fetchWeiboPreview(url, timeoutSeconds);
  const doubanApiUrl = doubanReviewApiUrl(url);
  const response = await withTimeout(requestUrl({
    url: doubanApiUrl ?? url,
    method: "GET",
    headers: doubanApiUrl ? {
      accept: "application/json",
      referer: "https://m.douban.com/",
      "user-agent": "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/150 Safari/537.36 ArticleInbox/1.1"
    } : { "user-agent": "Mozilla/5.0 ArticleInbox/1.0" },
    throw: false
  }), timeoutSeconds * 1000);
  if (response.status < 200 || response.status >= 300) throw new Error(`网页请求失败 (${response.status})`);
  if (new TextEncoder().encode(response.text).byteLength > MAX_PREVIEW_HTML_BYTES) throw new Error("网页超过预览安全上限");
  if (doubanApiUrl) return doubanReviewPreview(response.json ?? JSON.parse(response.text));
  if (isXiaohongshuNoteUrl(url)) return xiaohongshuPreview(response.text, url);
  return parseArticlePreview(response.text, url);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error("文章信息读取超时")), milliseconds);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { window.clearTimeout(timer); }
}

