const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif"
};

const URL_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);
const IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8";
const DESKTOP_BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150 Safari/537.36";
const MOBILE_BROWSER_USER_AGENT = "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/150 Safari/537.36";
export const IMAGE_FOLDER_NAME = "ImageSource";

export interface ImageStoragePaths {
  folderPath: string;
  vaultPath: string;
  markdownPath: string;
}

export interface ImageRequestAttempt {
  url: string;
  headers: Record<string, string>;
}

export function imageExtension(url: string, contentType?: string, data?: ArrayBuffer): string | null {
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalizedType) {
    if (CONTENT_TYPE_EXTENSIONS[normalizedType]) return CONTENT_TYPE_EXTENSIONS[normalizedType];
    if (normalizedType !== "application/octet-stream") return null;
  }
  try {
    const format = new URL(url).searchParams.get("wx_fmt")?.toLowerCase();
    if (format && URL_EXTENSIONS.has(format)) return format === "jpeg" ? "jpg" : format;
  } catch { /* Fall through to path and byte-signature detection. */ }
  const match = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
  const extension = match?.[1]?.toLowerCase();
  if (extension && URL_EXTENSIONS.has(extension)) return extension === "jpeg" ? "jpg" : extension;
  return data ? imageExtensionFromBytes(data) : null;
}

export function imageExtensionFromBytes(data: ArrayBuffer): string | null {
  const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 16));
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))) return "gif";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
    && /^(?:avif|avis)$/.test(String.fromCharCode(...bytes.slice(8, 12)))) return "avif";
  return null;
}

export function imageFileName(captureId: string, index: number, extension: string): string {
  const safeId = captureId.replace(/[^a-z0-9_-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${safeId || "article"}-${String(index + 1).padStart(3, "0")}.${extension}`;
}

/**
 * Keep the physical Vault path and the note-relative Markdown path separate.
 * The physical image must always live under the configured inbox directory.
 */
export function imageStoragePaths(articleRoot: string, fileName: string): ImageStoragePaths {
  const folderPath = `${articleRoot}/${IMAGE_FOLDER_NAME}`;
  return {
    folderPath,
    vaultPath: `${folderPath}/${fileName}`,
    markdownPath: `${IMAGE_FOLDER_NAME}/${fileName}`
  };
}

export function localizeImageReference(markdown: string, sourceUrl: string, localPath: string): string {
  const escapedUrl = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`!\\[((?:\\\\.|[^\\]])*)\\]\\(${escapedUrl}\\)`, "g");
  return markdown.replace(pattern, (_match, alt: string) => `![${alt}](${localPath})`);
}

/**
 * Douban's image CDN may return an HTML anti-hotlink page with HTTP 200.
 * Try canonical desktop and mobile referers, then make a no-referer request.
 */
export function imageRequestAttempts(imageUrl: string, articleUrl: string): ImageRequestAttempt[] {
  if (isDoubanImageUrl(imageUrl)) {
    return [
      { url: imageUrl, headers: { "user-agent": DESKTOP_BROWSER_USER_AGENT, referer: canonicalDoubanReferer(articleUrl), accept: IMAGE_ACCEPT } },
      { url: imageUrl, headers: { "user-agent": MOBILE_BROWSER_USER_AGENT, referer: "https://m.douban.com/", accept: IMAGE_ACCEPT } },
      { url: imageUrl, headers: { "user-agent": DESKTOP_BROWSER_USER_AGENT, accept: IMAGE_ACCEPT } }
    ];
  }
  if (isWeiboImageUrl(imageUrl)) {
    const candidates = weiboImageCandidates(imageUrl);
    return [
      { url: candidates[0]!, headers: { "user-agent": DESKTOP_BROWSER_USER_AGENT, referer: articleUrl, accept: IMAGE_ACCEPT } },
      { url: candidates[0]!, headers: { "user-agent": DESKTOP_BROWSER_USER_AGENT, referer: "https://weibo.com/", accept: IMAGE_ACCEPT } },
      ...candidates.slice(1).map((url) => ({
        url,
        headers: { "user-agent": DESKTOP_BROWSER_USER_AGENT, referer: "https://weibo.com/", accept: IMAGE_ACCEPT }
      })),
      { url: candidates[0]!, headers: { "user-agent": DESKTOP_BROWSER_USER_AGENT, accept: IMAGE_ACCEPT } }
    ];
  }
  return [
    { url: imageUrl, headers: { "user-agent": "Mozilla/5.0 ArticleInbox/1.0", referer: articleUrl, accept: IMAGE_ACCEPT } },
    { url: imageUrl, headers: { accept: IMAGE_ACCEPT } }
  ];
}

export function isDoubanImageUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return host === "doubanio.com" || host.endsWith(".doubanio.com");
  } catch { return false; }
}

export function isXiaohongshuImageUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return host === "xhscdn.com" || host.endsWith(".xhscdn.com")
      || host === "xhscdn.net" || host.endsWith(".xhscdn.net");
  } catch { return false; }
}

export function isWeiboImageUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return host === "sinaimg.cn" || host.endsWith(".sinaimg.cn")
      || host === "sinaimg.com" || host.endsWith(".sinaimg.com")
      || host === "weibocdn.com" || host.endsWith(".weibocdn.com");
  } catch { return false; }
}

/**
 * Sina keeps the same public image object on several first-party CDN aliases.
 * A regional edge can answer 403 while another official edge still serves it,
 * so retain the original URL and add bounded same-provider fallbacks.
 */
export function weiboImageCandidates(input: string): string[] {
  if (!isWeiboImageUrl(input)) return [input];
  try {
    const source = new URL(input);
    if (!source.hostname.toLowerCase().endsWith(".sinaimg.cn")
      && !source.hostname.toLowerCase().endsWith(".sinaimg.com")) return [source.toString()];
    const number = /(?:wx|ww|tva|tvax)(\d+)\./i.exec(source.hostname)?.[1] ?? "1";
    const aliases = [`tva${number}.sinaimg.cn`, `tvax${number}.sinaimg.cn`, `ww${number}.sinaimg.cn`];
    const urls = [source.toString()];
    for (const hostname of aliases) {
      const candidate = new URL(source);
      candidate.protocol = "https:";
      candidate.hostname = hostname;
      urls.push(candidate.toString());
    }
    return [...new Set(urls)];
  } catch { return [input]; }
}

function canonicalDoubanReferer(articleUrl: string): string {
  try {
    const url = new URL(articleUrl);
    const host = url.hostname.toLowerCase();
    if (host === "douban.com" || host.endsWith(".douban.com")) {
      const reviewId = /\/(?:doubanapp\/dispatch\/)?review\/(\d{5,20})(?:\/|$)/.exec(url.pathname)?.[1];
      if (reviewId) return `https://www.douban.com/review/${reviewId}/`;
    }
  } catch { /* Use the stable site referer below. */ }
  return "https://www.douban.com/";
}
