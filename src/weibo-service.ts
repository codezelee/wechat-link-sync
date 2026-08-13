import { requestUrl } from "obsidian";
import type { ParsedArticle } from "./models.js";
import {
  parseWeiboStatusPayload,
  parseWeiboVisitorPayload,
  weiboStatusId,
  weiboStatusIsLong,
  weiboPreviewFromStatus,
  type WeiboPreview,
  type WeiboVisitorSession
} from "./weibo.js";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150 Safari/537.36";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
let cachedVisitor: { value: WeiboVisitorSession; expiresAt: number } | null = null;
let visitorRequest: Promise<WeiboVisitorSession> | null = null;

export async function fetchWeiboArticle(sourceUrl: string, timeoutSeconds: number): Promise<ParsedArticle> {
  const status = await fetchStatus(sourceUrl, timeoutSeconds);
  let longText: unknown = null;
  if (weiboStatusIsLong(status)) {
    const id = weiboStatusId(sourceUrl)!;
    const response = await authenticatedRequest(`https://weibo.com/ajax/statuses/longtext?id=${encodeURIComponent(id)}`, timeoutSeconds);
    longText = parseJson(response.text, "微博长文本");
  }
  return parseWeiboStatusPayload(status, longText, sourceUrl);
}

export async function fetchWeiboPreview(sourceUrl: string, timeoutSeconds: number): Promise<WeiboPreview> {
  return weiboPreviewFromStatus(await fetchStatus(sourceUrl, timeoutSeconds), sourceUrl);
}

async function fetchStatus(sourceUrl: string, timeoutSeconds: number): Promise<unknown> {
  const id = weiboStatusId(sourceUrl);
  if (!id) throw new Error("不是支持的微博正文链接");
  const response = await authenticatedRequest(`https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(id)}`, timeoutSeconds);
  return parseJson(response.text, "微博正文");
}

async function authenticatedRequest(url: string, timeoutSeconds: number) {
  let response = await requestWithSession(url, await visitorSession(timeoutSeconds), timeoutSeconds);
  if (response.status === 401 || response.status === 403) {
    cachedVisitor = null;
    response = await requestWithSession(url, await visitorSession(timeoutSeconds), timeoutSeconds);
  }
  if (response.status === 401 || response.status === 403) {
    cachedVisitor = null;
    throw new Error("微博限制了本次访客访问，请稍后再次处理");
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`微博请求失败 (${response.status})`);
  if (new TextEncoder().encode(response.text).byteLength > MAX_RESPONSE_BYTES) throw new Error("微博响应超过 8 MiB 安全上限");
  return response;
}

function requestWithSession(url: string, session: WeiboVisitorSession, timeoutSeconds: number) {
  return timedRequest({
    url,
    method: "GET",
    headers: {
      accept: "application/json,text/plain,*/*",
      referer: "https://weibo.com/",
      "user-agent": USER_AGENT,
      cookie: `SUB=${session.sub}; SUBP=${session.subp}`
    },
    throw: false
  }, timeoutSeconds);
}

async function visitorSession(timeoutSeconds: number): Promise<WeiboVisitorSession> {
  if (cachedVisitor && cachedVisitor.expiresAt > Date.now()) return cachedVisitor.value;
  if (visitorRequest) return visitorRequest;
  visitorRequest = (async () => {
    const body = new URLSearchParams({ cb: "visitor_gray_callback", tid: "", from: "weibo" }).toString();
    const response = await timedRequest({
      url: "https://passport.weibo.com/visitor/genvisitor2",
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT
      },
      body,
      throw: false
    }, timeoutSeconds);
    if (response.status < 200 || response.status >= 300) throw new Error(`微博访客会话请求失败 (${response.status})`);
    const value = parseWeiboVisitorPayload(response.text);
    cachedVisitor = { value, expiresAt: Date.now() + 20 * 60 * 1000 };
    return value;
  })();
  try { return await visitorRequest; }
  finally { visitorRequest = null; }
}

async function timedRequest(options: Parameters<typeof requestUrl>[0], timeoutSeconds: number) {
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error("微博请求超时")), timeoutSeconds * 1000);
  });
  try { return await Promise.race([requestUrl(options), timeout]); }
  finally { window.clearTimeout(timer); }
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label}返回的不是有效数据`); }
}

