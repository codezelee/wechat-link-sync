import { App, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import type { CaptureSummary } from "./contracts.js";
import type { ArticleInboxSettings, ParsedArticle } from "./models.js";
import { buildArticleContent, captureIdFromMarkdown } from "./article-note.js";
import {
  IMAGE_FOLDER_NAME,
  imageExtension,
  imageFileName,
  imageRequestAttempts,
  imageStoragePaths,
  isDoubanImageUrl,
  isWeiboImageUrl,
  isXiaohongshuImageUrl,
  localizeImageReference
} from "./image-assets.js";
import { assertVaultRelative, isSafePublicUrl, safeFileName } from "./path-utils.js";

const LEGACY_PLUGIN_ROOTS = ["_article-inbox-tmp", "_article-inbox-recovery"] as const;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ARTICLE_IMAGE_BYTES = 100 * 1024 * 1024;

export interface WriteResult {
  path: string;
  warnings: string[];
  duplicate: boolean;
}

/**
 * Writes one Markdown note into the configured inbox folder and stores every
 * successfully downloaded image in the shared ImageSource child folder.
 */
export class VaultWriter {
  constructor(private readonly app: App) {}

  async write(
    capture: CaptureSummary,
    article: ParsedArticle,
    settings: ArticleInboxSettings
  ): Promise<WriteResult> {
    const existing = this.findCapture(capture.id);
    if (existing) return { path: existing.path, warnings: [], duplicate: true };

    const articleRoot = assertVaultRelative(settings.articleDirectory);
    const baseName = safeFileName(article.title);
    await this.ensureFolder(articleRoot);

    const resolved = await this.resolveFinalMarkdownPath(articleRoot, baseName, capture.id);
    if (resolved.duplicate) return { path: resolved.path, warnings: [], duplicate: true };

    const prepared = await this.prepareImages(capture, article, articleRoot, settings.fetchTimeoutSeconds);
    const localizedArticle = { ...article, markdown: prepared.markdown };
    const content = buildArticleContent(capture, localizedArticle, settings);
    const createdImages: TFile[] = [];

    try {
      if (prepared.images.length) await this.ensureFolder(`${articleRoot}/${IMAGE_FOLDER_NAME}`);
      for (const image of prepared.images) {
        const expectedPath = normalizePath(image.vaultPath);
        const existingImage = this.app.vault.getAbstractFileByPath(expectedPath);
        if (existingImage instanceof TFile) continue;
        if (existingImage) throw new Error(`图片路径已被目录占用：${image.vaultPath}`);
        const created = await this.app.vault.createBinary(expectedPath, image.data);
        if (normalizePath(created.path) !== expectedPath) {
          try { await this.app.fileManager.trashFile(created); }
          catch { /* Keep the path invariant error as the primary failure. */ }
          throw new Error(`图片实际写入路径异常：${created.path}`);
        }
        createdImages.push(created);
      }
      await this.app.vault.create(normalizePath(resolved.path), content);
      return { path: resolved.path, warnings: prepared.warnings, duplicate: false };
    } catch (error) {
      for (const image of createdImages.reverse()) {
        try { await this.app.fileManager.trashFile(image); }
        catch { /* Preserve the original write error; orphaned files are safe to keep. */ }
      }
      throw new Error(`VAULT_WRITE_FAILED: ${messageOf(error)}`);
    }
  }

  /**
   * Re-fetches one processed capture into the same Markdown file. All downloads
   * finish before the Vault is changed. Existing Markdown and image bytes are
   * restored if any later write fails. Images no longer referenced by the new
   * article are intentionally left alone for the user to manage.
   */
  async rewrite(
    capture: CaptureSummary,
    article: ParsedArticle,
    settings: ArticleInboxSettings
  ): Promise<WriteResult> {
    const existingMarkdown = this.findCapture(capture.id);
    if (!existingMarkdown) return this.write(capture, article, settings);

    const articleRoot = assertVaultRelative(settings.articleDirectory);
    const prepared = await this.prepareImages(capture, article, articleRoot, settings.fetchTimeoutSeconds);
    const content = buildArticleContent(capture, { ...article, markdown: prepared.markdown }, settings);
    const oldMarkdown = await this.app.vault.read(existingMarkdown);
    const createdImages: TFile[] = [];
    const replacedImages: Array<{ file: TFile; data: ArrayBuffer }> = [];
    let markdownChanged = false;

    try {
      if (prepared.images.length) await this.ensureFolder(`${articleRoot}/${IMAGE_FOLDER_NAME}`);
      for (const image of prepared.images) {
        const expectedPath = normalizePath(image.vaultPath);
        const existingImage = this.app.vault.getAbstractFileByPath(expectedPath);
        if (existingImage instanceof TFile) {
          replacedImages.push({ file: existingImage, data: await this.app.vault.readBinary(existingImage) });
          await this.app.vault.modifyBinary(existingImage, image.data);
          continue;
        }
        if (existingImage) throw new Error(`图片路径已被目录占用：${image.vaultPath}`);
        const created = await this.app.vault.createBinary(expectedPath, image.data);
        if (normalizePath(created.path) !== expectedPath) {
          try { await this.app.fileManager.trashFile(created); }
          catch { /* Preserve the path invariant error. */ }
          throw new Error(`图片实际写入路径异常：${created.path}`);
        }
        createdImages.push(created);
      }
      markdownChanged = true;
      await this.app.vault.modify(existingMarkdown, content);
      return { path: existingMarkdown.path, warnings: prepared.warnings, duplicate: false };
    } catch (error) {
      if (markdownChanged) {
        try { await this.app.vault.modify(existingMarkdown, oldMarkdown); }
        catch { /* Preserve the primary rewrite error. */ }
      }
      for (const image of replacedImages.reverse()) {
        try { await this.app.vault.modifyBinary(image.file, image.data); }
        catch { /* Preserve the primary rewrite error. */ }
      }
      for (const image of createdImages.reverse()) {
        try { await this.app.fileManager.trashFile(image); }
        catch { /* Preserve the primary rewrite error. */ }
      }
      throw new Error(`VAULT_WRITE_FAILED: ${messageOf(error)}`);
    }
  }

  private async prepareImages(
    capture: CaptureSummary,
    article: ParsedArticle,
    articleRoot: string,
    timeoutSeconds: number
  ): Promise<{ markdown: string; images: DownloadedImage[]; warnings: string[] }> {
    let markdown = article.markdown;
    let totalBytes = 0;
    const images: DownloadedImage[] = [];
    const warnings: string[] = [];

    for (let index = 0; index < article.images.length; index += 1) {
      const image = article.images[index]!;
      if (!isSafePublicUrl(image.url)) {
        warnings.push(`图片 ${index + 1} 保留远程地址：非公开或不安全地址`);
        continue;
      }
      try {
        const downloaded = await downloadImage(image.url, capture.originalUrl, timeoutSeconds);
        const response = downloaded.response;
        const bytes = response.arrayBuffer.byteLength;
        if (bytes === 0) throw new Error("图片内容为空");
        if (bytes > MAX_IMAGE_BYTES) throw new Error("单图超过 20 MiB");
        if (totalBytes + bytes > MAX_ARTICLE_IMAGE_BYTES) throw new Error("单篇图片总量超过 100 MiB");
        totalBytes += bytes;

        const fileName = imageFileName(capture.id, index, downloaded.extension);
        const paths = imageStoragePaths(articleRoot, fileName);
        images.push({ vaultPath: paths.vaultPath, data: response.arrayBuffer });
        markdown = localizeImageReference(markdown, image.url, paths.markdownPath);
      } catch (error) {
        const detail = `图片 ${index + 1} 本地化失败：${messageOf(error)}`;
        if (isWechatImageUrl(image.url) || isDoubanImageUrl(image.url)
          || isXiaohongshuImageUrl(image.url) || isWeiboImageUrl(image.url)) {
          throw new Error(detail);
        }
        warnings.push(`${detail}；已保留远程地址`);
      }
    }
    return { markdown, images, warnings };
  }

  findCapture(captureId: string): TFile | null {
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.app.metadataCache.getFileCache(file)?.frontmatter?.capture_id === captureId) return file;
    }
    return null;
  }

  /** Remove only empty roots left by 1.1.4/1.1.5. Never removes user data. */
  async removeEmptyLegacyRoots(): Promise<number> {
    let removed = 0;
    for (const path of LEGACY_PLUGIN_ROOTS) {
      const item = this.app.vault.getAbstractFileByPath(path);
      if (item instanceof TFolder && item.children.length === 0) {
        await this.app.fileManager.trashFile(item);
        removed += 1;
      }
    }
    return removed;
  }

  private async resolveFinalMarkdownPath(
    articleRoot: string,
    baseName: string,
    captureId: string
  ): Promise<{ path: string; duplicate: boolean }> {
    const candidates = [
      `${articleRoot}/${baseName}.md`,
      `${articleRoot}/${baseName}-${captureId.slice(0, 8)}.md`
    ];
    for (const path of candidates) {
      const item = this.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(item instanceof TFile)) {
        if (!item) return { path, duplicate: false };
        continue;
      }
      if (captureIdFromMarkdown(await this.app.vault.cachedRead(item)) === captureId) {
        return { path, duplicate: true };
      }
    }
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const path = `${articleRoot}/${baseName}-${captureId.slice(0, 8)}-${suffix}.md`;
      if (!this.app.vault.getAbstractFileByPath(normalizePath(path))) return { path, duplicate: false };
    }
    throw new Error("VAULT_WRITE_FAILED: 无法生成不重复的 Markdown 文件名");
  }

  private async ensureFolder(path: string): Promise<TFolder> {
    const parts = normalizePath(path).split("/");
    let current = "";
    let folder: TFolder | null = null;
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      let item = this.app.vault.getAbstractFileByPath(current);
      if (!item) item = await this.app.vault.createFolder(current);
      if (!(item instanceof TFolder)) throw new Error(`目录路径已被文件占用：${current}`);
      folder = item;
    }
    if (!folder) throw new Error("目录路径不能为空");
    return folder;
  }
}

interface DownloadedImage {
  vaultPath: string;
  data: ArrayBuffer;
}

async function downloadImage(url: string, referer: string, timeoutSeconds: number) {
  const attempts = imageRequestAttempts(url, referer);
  let lastError = "未知错误";
  for (const attempt of attempts) {
    try {
      const response = await withTimeout(requestUrl({
        url: attempt.url,
        method: "GET",
        headers: attempt.headers,
        throw: false
      }), timeoutSeconds * 1000);
      if (response.status < 200 || response.status >= 300) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      if (response.arrayBuffer.byteLength === 0) {
        lastError = "图片内容为空";
        continue;
      }
      const contentType = header(response.headers, "content-type");
      const extension = imageExtension(attempt.url, contentType, response.arrayBuffer);
      if (!extension) {
        lastError = `响应不是支持的图片格式（Content-Type: ${contentType ?? "缺失"}）`;
        continue;
      }
      return { response, extension };
    } catch (error) { lastError = messageOf(error); }
  }
  throw new Error(lastError);
}

function isWechatImageUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return host === "mmbiz.qpic.cn" || host.endsWith(".mmbiz.qpic.cn");
  } catch { return false; }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error("图片请求超时")), milliseconds);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { window.clearTimeout(timer); }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
