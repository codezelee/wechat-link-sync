import DefuddlePackage from "defuddle/full";
import type { DefuddleOptions, DefuddleResponse } from "defuddle";
import TurndownService from "turndown";
import type { ParsedArticle } from "./models.js";

const EXTRACTOR_VERSION = "2.1.0";
const MINIMUM_CONTENT_LENGTH = 40;
const IMAGE_MARKER_PREFIX = "ARTICLEINBOXIMAGE";
const IMAGE_MARKER_SUFFIX = "END";
const CODE_FONT_PATTERN = /(?:monospace|menlo|monaco|consolas|courier)/i;
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "FIGCAPTION", "FIGURE",
  "FOOTER", "HEADER", "LI", "MAIN", "NAV", "P", "SECTION", "TR"
]);
const Defuddle = DefuddlePackage as unknown as new (
  document: Document,
  options?: DefuddleOptions
) => { parse(): DefuddleResponse };

export function parseArticle(html: string, sourceUrl: string): ParsedArticle {
  const document = new DOMParser().parseFromString(html, "text/html");
  const wechatContent = document.querySelector<HTMLElement>("#js_content");
  const isWechat = Boolean(wechatContent);

  // Preserve page metadata before Defuddle sanitizes and normalizes the document.
  const pageTitle = text(document.querySelector("#activity-name")) || meta(document, "og:title") || document.title;
  const pageAuthor = text(document.querySelector("#js_name")) || meta(document, "author");
  const pagePublishedAt = text(document.querySelector("#publish_time")) || meta(document, "article:published_time");

  absolutizeImages(document, sourceUrl);
  const extractionRoot = wechatContent ?? document.body;
  const headingColors = isWechat ? collectHeadingColors(extractionRoot) : [];
  if (isWechat) preserveWechatSemantics(extractionRoot);
  const markedImages = markImages(extractionRoot);
  const result = new Defuddle(document, {
    url: sourceUrl,
    separateMarkdown: true,
    useAsync: false,
    includeReplies: false,
    ...(isWechat ? {
      contentSelector: "#js_content",
      // The selector already limits extraction to the article body. Retaining these
      // blocks is safer for heavily styled WeChat articles than score-based removal.
      removeLowScoring: false,
      removeContentPatterns: false,
      removeSmallImages: false
    } : {})
  }).parse();

  const title = cleanTitle((isWechat ? pageTitle : result.title) || pageTitle, sourceUrl);
  const restored = restoreImageMarkers(markdownFromResult(result.contentMarkdown, result.content), markedImages);
  const markdown = applyHeadingColors(normalizeMarkdown(restored, title), headingColors);
  if (visibleLength(markdown) < MINIMUM_CONTENT_LENGTH) {
    throw new Error("CONTENT_NOT_FOUND: 未提取到有效正文");
  }

  return {
    title,
    ...((pageAuthor || result.author) ? { author: (pageAuthor || result.author).trim() } : {}),
    ...((pagePublishedAt || result.published) ? { publishedAt: (pagePublishedAt || result.published).trim() } : {}),
    ...(result.description ? { description: result.description.trim() } : {}),
    markdown,
    images: uniqueImages(markedImages),
    extractor: isWechat ? "wechat-defuddle" : "generic-defuddle",
    extractorVersion: EXTRACTOR_VERSION
  };
}

interface MarkedImage {
  marker: string;
  url: string;
  alt: string;
}

interface HeadingColor {
  text: string;
  color: string;
}

/**
 * WeChat articles often encode meaning only in inline CSS. Convert the small
 * semantic subset Markdown can represent before Defuddle removes page styles.
 */
function preserveWechatSemantics(root: ParentNode): void {
  preserveInlineBold(root);
  preserveVisualCodeLines(root);
}

function preserveInlineBold(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    if (element.closest("strong, b")) return;
    const weight = element.style.fontWeight.trim().toLowerCase();
    const numericWeight = /^\d+$/.test(weight) ? Number(weight) : 0;
    if (weight !== "bold" && weight !== "bolder" && numericWeight < 600) return;
    const strong = element.ownerDocument.createElement("strong");
    while (element.firstChild) strong.appendChild(element.firstChild);
    element.appendChild(strong);
    element.style.removeProperty("font-weight");
  });
}

function preserveVisualCodeLines(root: ParentNode): void {
  const candidates = [...root.querySelectorAll<HTMLElement>("pre, [style], [class]")]
    .filter((element) => isCodeLike(element))
    .filter((element, _index, all) => !all.some((candidate) => candidate !== element && candidate.contains(element)));

  for (const element of candidates) {
    const visualText = visualTextContent(element);
    if (!visualText.includes("\n")) continue;
    const pre = element.ownerDocument.createElement("pre");
    const code = element.ownerDocument.createElement("code");
    code.textContent = visualText;
    pre.appendChild(code);
    element.replaceWith(pre);
  }
}

function isCodeLike(element: HTMLElement): boolean {
  if (element.tagName === "PRE") return true;
  const style = `${element.style.fontFamily} ${element.style.whiteSpace}`;
  const className = typeof element.className === "string" ? element.className : "";
  return CODE_FONT_PATTERN.test(style) || /(?:^|[-_\s])code(?:[-_\s]|$)/i.test(className) || /pre-wrap|pre-line/.test(style);
}

function visualTextContent(root: HTMLElement): string {
  const output: string[] = [];
  const appendNewline = () => {
    if (output.length && output[output.length - 1] !== "\n") output.push("\n");
  };
  const visit = (node: Node): void => {
    if (node.nodeType === node.TEXT_NODE) {
      const value = node.textContent ?? "";
      if (!/^\s+$/.test(value) || !value.includes("\n")) output.push(value);
      return;
    }
    if (!(node.instanceOf(Element))) return;
    if (node.tagName === "BR") {
      appendNewline();
      return;
    }
    const html = node as HTMLElement;
    const className = typeof html.className === "string" ? html.className : "";
    if (/(?:line[-_ ]?number|code[-_ ]?index)/i.test(className)) return;
    const isBlock = BLOCK_TAGS.has(node.tagName) || html.style.display === "block";
    if (isBlock) appendNewline();
    node.childNodes.forEach(visit);
    if (isBlock) appendNewline();
  };
  root.childNodes.forEach(visit);
  return output.join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\s*\n|\n\s*$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function markImages(root: ParentNode): MarkedImage[] {
  const images: MarkedImage[] = [];
  root.querySelectorAll<HTMLImageElement>("img[src]").forEach((image, index) => {
    const url = image.src;
    if (!url) return;
    const marker = `${IMAGE_MARKER_PREFIX}${String(index + 1).padStart(6, "0")}${IMAGE_MARKER_SUFFIX}`;
    images.push({ marker, url, alt: image.alt.trim() || "图片" });
    image.replaceWith(image.ownerDocument.createTextNode(marker));
  });
  return images;
}

function restoreImageMarkers(markdown: string, images: MarkedImage[]): string {
  let restored = markdown;
  for (const image of images) {
    const replacement = `\n\n${markdownImage(image.alt, image.url)}\n\n`;
    if (restored.includes(image.marker)) restored = restored.split(image.marker).join(replacement);
    else restored += replacement;
  }
  return restored;
}

function uniqueImages(images: MarkedImage[]): Array<{ url: string; alt: string }> {
  return images
    .filter((image, index, all) => all.findIndex((candidate) => candidate.url === image.url) === index)
    .map(({ url, alt }) => ({ url, alt }));
}

function markdownImage(alt: string, url: string): string {
  const safeAlt = alt.replace(/\\/g, "\\\\").replace(/]/g, "\\]").replace(/\r?\n/g, " ");
  return `![${safeAlt}](${url})`;
}

function collectHeadingColors(root: ParentNode): HeadingColor[] {
  return [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")]
    .map((heading) => {
      const colored = [heading, ...heading.querySelectorAll<HTMLElement>("[style]")]
        .find((element) => safeCssColor(element.style.color || element.style.webkitTextFillColor));
      const color = colored ? safeCssColor(colored.style.color || colored.style.webkitTextFillColor) : null;
      return color ? { text: heading.textContent?.trim() ?? "", color } : null;
    })
    .filter((item): item is HeadingColor => Boolean(item?.text));
}

function applyHeadingColors(markdown: string, colors: HeadingColor[]): string {
  if (!colors.length) return markdown;
  return markdown.split("\n").map((line) => {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) return line;
    const plainText = plainMarkdownText(heading[2]!);
    const style = colors.find((item) => sameText(item.text, plainText));
    if (!style) return line;
    return `${heading[1]} <span style="color: ${style.color}">${escapeHtml(plainText)}</span>`;
  }).join("\n");
}

function safeCssColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (!color || color === "inherit" || color === "initial" || color === "transparent") return null;
  return /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s-]+\)|[a-z]+)$/.test(color) ? color : null;
}

function plainMarkdownText(value: string): string {
  return value
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`~]/g, "")
    .trim();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function markdownFromResult(markdown: string | undefined, html: string): string {
  if (markdown && !markdown.startsWith("Partial conversion completed with errors.")) return markdown;

  // Defuddle/full normally provides Markdown directly. This fallback keeps the
  // cleaned HTML usable if its optional converter is unavailable at runtime.
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced"
  });
  turndown.addRule("cleanImage", {
    filter: "img",
    replacement(_content, node) {
      const image = node as HTMLImageElement;
      return image.src ? `\n\n![${(image.alt || "图片").replace(/]/g, "\\]")}](${image.src})\n\n` : "";
    }
  });
  return turndown.turndown(html);
}

function normalizeMarkdown(input: string, title: string): string {
  let markdown = input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^#{1,6}[ \t]*$/gm, "")
    .replace(/^# ([^#].*)$/gm, "## $1")
    .replace(/^```(?:js|javascript|ts|typescript|css)\n([\s\S]*?)^```$/gim, (_match, content: string) => {
      return looksLikeProse(content) ? `\`\`\`\n${content}\`\`\`` : _match;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = markdown.split("\n").filter((line) => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    return !heading || !sameText(heading[1]!, title);
  });
  markdown = lines.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").trim();
  return markdown;
}

function looksLikeProse(content: string): boolean {
  const value = content.trim();
  if (!value) return false;
  const cjk = value.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const codeSignals = value.match(/[{}=<>]|\b(?:const|let|var|function|class|return|import|export)\b/g)?.length ?? 0;
  return cjk >= 4 && codeSignals === 0;
}

function absolutizeImages(root: ParentNode, sourceUrl: string): void {
  root.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const source = image.getAttribute("data-src")
      || image.getAttribute("data-original")
      || image.getAttribute("data-backsrc")
      || image.getAttribute("src");
    if (!source) return;
    try { image.src = new URL(source, sourceUrl).toString(); }
    catch { image.removeAttribute("src"); }
    image.removeAttribute("srcset");
    image.removeAttribute("data-srcset");
  });
}

function cleanTitle(rawTitle: string, sourceUrl: string): string {
  return rawTitle.trim().replace(/\s+/g, " ") || new URL(sourceUrl).hostname;
}

function visibleLength(markdown: string): number {
  return markdown.replace(/!\[[^\]]*]\([^)]*\)/g, "").replace(/[`#>*_\-\s]/g, "").length;
}

function sameText(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize("NFKC").replace(/[\s*_`]+/g, "").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function text(node: Element | null): string { return node?.textContent?.trim() ?? ""; }
function meta(document: Document, property: string): string {
  return document.querySelector<HTMLMetaElement>(`meta[property="${property}"],meta[name="${property}"]`)?.content?.trim() ?? "";
}

