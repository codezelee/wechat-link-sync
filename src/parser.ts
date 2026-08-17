import DefuddlePackage from "defuddle/full";
import type { DefuddleOptions, DefuddleResponse } from "defuddle";
import TurndownService from "turndown";
import type { ParsedArticle } from "./models.js";
import { extractPublishedAt } from "./published-at.js";

const EXTRACTOR_VERSION = "2.6.0";
const MINIMUM_CONTENT_LENGTH = 40;
const IMAGE_MARKER_PREFIX = "ARTICLEINBOXIMAGE";
const IMAGE_MARKER_SUFFIX = "END";
const UNDERLINE_MARKER_PREFIX = "ARTICLEINBOXUNDERLINE";
const COLOR_MARKER_PREFIX = "ARTICLEINBOXCOLOR";
const CENTER_ALIGNMENT_MARKER_PREFIX = "ARTICLEINBOXCENTER";
const CENTERABLE_BLOCK_SELECTOR = "center, div, figcaption, h1, h2, h3, h4, h5, h6, p, section";
const CODE_FONT_PATTERN = /(?:monospace|menlo|monaco|consolas|courier)/i;
const VISUAL_CODE_LINE_PATTERN = /(?:^|[-_\s])(?:code[-_]?snippet[-_]+(?:outer|line)|code[-_]?line|line[-_]?content|hljs[-_]?ln[-_]?code)(?:[-_\s]|$)/i;
const CODE_LINE_INDEX_PATTERN = /(?:line[-_ ]?number|code[-_ ]?index|code[-_]?snippet[-_]+line[-_]+index)/i;
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
  const pagePublishedAt = extractPublishedAt(document);

  absolutizeImages(document, sourceUrl);
  const extractionRoot = wechatContent ?? document.body;
  const headingColors = isWechat ? collectHeadingColors(extractionRoot) : [];
  if (isWechat) preserveWechatSemantics(extractionRoot);
  const markedUnderlines = isWechat ? markUnderlines(extractionRoot) : [];
  const markedColors = isWechat ? markTextColors(extractionRoot) : [];
  const markedCenterAlignments = isWechat ? markCenterAlignments(extractionRoot) : [];
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
  const restored = restoreCenterAlignmentMarkers(
    restoreTextColorMarkers(
      restoreUnderlineMarkers(
        restoreImageMarkers(markdownFromResult(result.contentMarkdown, result.content), markedImages),
        markedUnderlines
      ),
      markedColors
    ),
    markedCenterAlignments
  );
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

interface MarkedUnderline {
  startMarker: string;
  endMarker: string;
  openingTag: string;
  closingTag: string;
}

interface MarkedTextColor {
  startMarker: string;
  endMarker: string;
  color: string;
}

interface MarkedCenterAlignment {
  startMarker: string;
  endMarker: string;
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
    // Keep bold inside the same safe HTML span as a visual underline. Markdown
    // emphasis nested inside inline HTML is displayed literally by Obsidian.
    if (underlineTags(element)) return;
    const strong = element.ownerDocument.createElement("strong");
    while (element.firstChild) strong.appendChild(element.firstChild);
    element.appendChild(strong);
    element.style.removeProperty("font-weight");
  });
}

function markUnderlines(root: ParentNode): MarkedUnderline[] {
  const candidates = [...root.querySelectorAll<HTMLElement>("u, ins, [style]")]
    .map((element) => ({ element, tags: underlineTags(element) }))
    .filter((candidate): candidate is { element: HTMLElement; tags: { openingTag: string; closingTag: string } } => Boolean(candidate.tags))
    .filter(({ element }, _index, all) => !all.some((ancestor) => ancestor.element !== element && ancestor.element.contains(element)))
    .filter(({ element }) => Boolean(element.textContent?.trim()))
    .filter(({ element }) => !element.querySelector("address, article, aside, blockquote, div, figure, footer, header, img, li, main, nav, p, pre, section, table"));

  return candidates.map(({ element, tags }, index) => {
    const markerId = String(index + 1).padStart(6, "0");
    const startMarker = `${UNDERLINE_MARKER_PREFIX}${markerId}START`;
    const endMarker = `${UNDERLINE_MARKER_PREFIX}${markerId}END`;
    element.prepend(element.ownerDocument.createTextNode(startMarker));
    element.append(element.ownerDocument.createTextNode(endMarker));
    return { startMarker, endMarker, ...tags };
  });
}

function underlineTags(element: HTMLElement): { openingTag: string; closingTag: string } | null {
  const borderBottom = safeBottomBorder(element);
  const fontWeight = safeInlineFontWeight(element);
  const withWeight = (styles: string[]): string => [...styles, ...(fontWeight ? [`font-weight: ${fontWeight}`] : [])].join("; ");
  if (borderBottom && isInlineElement(element)) {
    return { openingTag: `<span style="${withWeight([`border-bottom: ${borderBottom}`])}">`, closingTag: "</span>" };
  }
  if (element.tagName === "U" || element.tagName === "INS") {
    return fontWeight
      ? { openingTag: `<u style="font-weight: ${fontWeight}">`, closingTag: "</u>" }
      : { openingTag: "<u>", closingTag: "</u>" };
  }
  const decoration = [
    element.style.textDecoration,
    element.style.textDecorationLine,
    element.style.getPropertyValue("-webkit-text-decoration")
  ].join(" ");
  if (!/(?:^|\s)underline(?:\s|$)/i.test(decoration)) return null;
  const color = safeCssColor(element.style.textDecorationColor);
  if (color || fontWeight) {
    const styles = ["text-decoration-line: underline", ...(color ? [`text-decoration-color: ${color}`] : [])];
    return { openingTag: `<span style="${withWeight(styles)}">`, closingTag: "</span>" };
  }
  return { openingTag: "<u>", closingTag: "</u>" };
}

function safeInlineFontWeight(element: HTMLElement): string | null {
  const weight = element.style.fontWeight.trim().toLowerCase();
  if (weight === "bold" || weight === "bolder") return "bold";
  if (!/^\d{3}$/.test(weight)) return null;
  const numeric = Number(weight);
  return numeric >= 600 && numeric <= 900 ? String(numeric) : null;
}

function safeBottomBorder(element: HTMLElement): string | null {
  const width = element.style.borderBottomWidth.trim().toLowerCase();
  const style = element.style.borderBottomStyle.trim().toLowerCase();
  const color = safeCssColor(element.style.borderBottomColor);
  const safeWidth = /^(?:thin|medium|thick|(?:0*\.)?[0-9]+(?:px|em|rem))$/.test(width) && !/^0(?:px|em|rem)?$/.test(width);
  if (!safeWidth || !/^(?:solid|dashed|dotted|double)$/.test(style) || !color) return null;
  return `${width} ${style} ${color}`;
}

function isInlineElement(element: HTMLElement): boolean {
  return /^(?:A|B|CODE|DEL|EM|I|INS|KBD|MARK|S|SMALL|SPAN|STRONG|SUB|SUP|U)$/.test(element.tagName);
}

function markTextColors(root: ParentNode): MarkedTextColor[] {
  const candidates = [...root.querySelectorAll<HTMLElement>("[style]")]
    .map((element) => ({ element, color: declaredTextColor(element) }))
    .filter((candidate): candidate is { element: HTMLElement; color: string } => Boolean(candidate.color))
    .filter(({ element, color }) => !sameCssColor(color, inheritedTextColor(element)))
    .filter(({ element }) => Boolean(element.textContent?.trim()))
    .filter(({ element }) => !element.querySelector("address, article, aside, blockquote, div, figure, footer, header, img, li, main, nav, p, pre, section, table"));

  return candidates.map(({ element, color }, index) => {
    const markerId = String(index + 1).padStart(6, "0");
    const startMarker = `${COLOR_MARKER_PREFIX}${markerId}START`;
    const endMarker = `${COLOR_MARKER_PREFIX}${markerId}END`;
    element.prepend(element.ownerDocument.createTextNode(startMarker));
    element.append(element.ownerDocument.createTextNode(endMarker));
    return { startMarker, endMarker, color };
  });
}

function inheritedTextColor(element: HTMLElement): string | null {
  let parent = element.parentElement;
  while (parent) {
    const color = declaredTextColor(parent);
    if (color) return color;
    parent = parent.parentElement;
  }
  return null;
}

function declaredTextColor(element: HTMLElement): string | null {
  const parsed = safeCssColor(element.style.color || element.style.webkitTextFillColor);
  if (parsed) return parsed;
  const declarations = element.getAttribute("style")?.split(";") ?? [];
  for (const declaration of declarations) {
    const match = /^\s*(?:color|-webkit-text-fill-color)\s*:\s*(.+?)\s*$/i.exec(declaration);
    const color = match ? safeCssColor(match[1]!) : null;
    if (color) return color;
  }
  return null;
}

function sameCssColor(left: string | null, right: string | null): boolean {
  if (!left || !right) return left === right;
  return comparableCssColor(left) === comparableCssColor(right);
}

function comparableCssColor(value: string): string {
  const color = value.trim().toLowerCase().replace(/\s+/g, "");
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(color)?.[1];
  if (!hex) return color;
  const expanded = hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex;
  return `rgb(${Number.parseInt(expanded.slice(0, 2), 16)},${Number.parseInt(expanded.slice(2, 4), 16)},${Number.parseInt(expanded.slice(4, 6), 16)})`;
}

function markCenterAlignments(root: ParentNode): MarkedCenterAlignment[] {
  const candidates = [...root.querySelectorAll<HTMLElement>(CENTERABLE_BLOCK_SELECTOR)]
    .filter((element) => Boolean(element.textContent?.trim()))
    .filter((element) => effectiveTextAlignment(element, root) === "center")
    .filter((element) => !element.querySelector(CENTERABLE_BLOCK_SELECTOR))
    .filter((element) => !element.querySelector("img, pre, table, ul, ol"));

  return candidates.map((element, index) => {
    const markerId = String(index + 1).padStart(6, "0");
    const startMarker = `${CENTER_ALIGNMENT_MARKER_PREFIX}${markerId}START`;
    const endMarker = `${CENTER_ALIGNMENT_MARKER_PREFIX}${markerId}END`;
    // Alignment markers are added after inline color and underline markers so
    // the restored block-style span remains the valid outer wrapper.
    element.prepend(element.ownerDocument.createTextNode(startMarker));
    element.append(element.ownerDocument.createTextNode(endMarker));
    return { startMarker, endMarker };
  });
}

function effectiveTextAlignment(element: HTMLElement, root: ParentNode): string | null {
  let current: HTMLElement | null = element;
  while (current) {
    const declared = declaredTextAlignment(current);
    if (declared) return declared;
    if (current === root) break;
    current = current.parentElement;
  }
  return null;
}

function declaredTextAlignment(element: HTMLElement): string | null {
  const inline = element.style.textAlign.trim().toLowerCase();
  if (inline) return inline;
  const legacy = element.getAttribute("align")?.trim().toLowerCase();
  if (legacy) return legacy;
  return element.tagName === "CENTER" ? "center" : null;
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
    if (!(node instanceof Element)) return;
    if (node.tagName === "BR") {
      appendNewline();
      return;
    }
    const html = node as HTMLElement;
    const className = typeof html.className === "string" ? html.className : "";
    if (CODE_LINE_INDEX_PATTERN.test(className)) return;
    const parent = node.parentElement;
    const isSiblingCodeLine = node.tagName === "CODE"
      && parent?.tagName === "PRE"
      && parent.children.length > 1
      && [...parent.children].every((child) => child.tagName === "CODE");
    const isVisualLine = isSiblingCodeLine
      || BLOCK_TAGS.has(node.tagName)
      || html.style.display === "block"
      || VISUAL_CODE_LINE_PATTERN.test(className);
    if (isVisualLine) appendNewline();
    node.childNodes.forEach(visit);
    if (isVisualLine) appendNewline();
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

function restoreUnderlineMarkers(markdown: string, underlines: MarkedUnderline[]): string {
  let restored = markdown;
  for (const underline of underlines) {
    restored = restored
      .split(underline.startMarker).join(underline.openingTag)
      .split(underline.endMarker).join(underline.closingTag);
  }
  return restored;
}

function restoreTextColorMarkers(markdown: string, colors: MarkedTextColor[]): string {
  let restored = markdown;
  for (const color of colors) {
    restored = restored
      .split(color.startMarker).join(`<span style="color: ${color.color}">`)
      .split(color.endMarker).join("</span>");
  }
  return restored;
}

function restoreCenterAlignmentMarkers(markdown: string, alignments: MarkedCenterAlignment[]): string {
  let restored = markdown;
  for (const alignment of alignments) {
    restored = restored
      .split(alignment.startMarker).join('<span style="display: block; text-align: center">')
      .split(alignment.endMarker).join("</span>");
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
  let inFence = false;
  let fenceMarker = "";
  return markdown.split("\n").map((line) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (!inFence) { inFence = true; fenceMarker = fence[0]!; }
      else if (fence[0] === fenceMarker) { inFence = false; fenceMarker = ""; }
      return line;
    }
    if (inFence) return line;
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
    .replace(/^```(?:js|javascript|ts|typescript|css)\n([\s\S]*?)^```$/gim, (_match, content: string) => {
      return looksLikeProse(content) ? `\`\`\`\n${content}\`\`\`` : _match;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  markdown = normalizeHeadingsOutsideFences(markdown, title);
  markdown = normalizeCompositeHeadingsOutsideFences(markdown);
  return markdown;
}

function normalizeHeadingsOutsideFences(markdown: string, title: string): string {
  const lines: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const original of markdown.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(original)?.[1];
    if (fence) {
      if (!inFence) { inFence = true; fenceMarker = fence[0]!; }
      else if (fence[0] === fenceMarker) { inFence = false; fenceMarker = ""; }
      lines.push(original);
      continue;
    }
    if (inFence) {
      lines.push(original);
      continue;
    }
    const line = original
      .replace(/^#{1,6}[ \t]*$/, "")
      .replace(/^# ([^#].*)$/, "## $1");
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!heading || !sameText(heading[1]!, title)) lines.push(line);
  }
  return lines.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeCompositeHeadingsOutsideFences(markdown: string): string {
  const lines = markdown.split("\n");
  const candidates = new Map<number, { title: string; label: string }>();
  let inFence = false;
  let fenceMarker = "";

  for (let index = 0; index < lines.length - 2; index += 1) {
    const line = lines[index]!;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (!inFence) { inFence = true; fenceMarker = fence[0]!; }
      else if (fence[0] === fenceMarker) { inFence = false; fenceMarker = ""; }
      continue;
    }
    if (inFence || lines[index + 1] !== "") continue;

    const title = line.trim();
    const label = lines[index + 2]!.trim();
    const plainTitle = plainMarkdownText(title);
    const plainLabel = plainMarkdownText(label);
    if (/^(?:#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|`{3,}|~{3,}|!\[)/.test(title)) continue;
    if (!/[\u3400-\u9fff][^\n]*[，,][^\n]*[\u3400-\u9fffA-Za-z]/.test(plainTitle)) continue;
    if (plainTitle.length < 4 || plainTitle.length > 80 || /[。！？!?；;：:]$/.test(plainTitle)) continue;
    if (!/^[A-Z][A-Z0-9 ./&+-]{1,23}$/.test(plainLabel) || !/[A-Z]{2}/.test(plainLabel)) continue;
    candidates.set(index, { title, label });
  }

  // Repeated bilingual labels are a strong signal for this WeChat heading
  // pattern; requiring two avoids promoting an incidental all-caps paragraph.
  if (candidates.size < 2) return markdown;

  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = candidates.get(index);
    if (!candidate) {
      output.push(lines[index]!);
      continue;
    }
    const labelText = plainMarkdownText(candidate.label);
    const labelColor = inlineColor(candidate.label);
    const labelStyle = labelColor ? `white-space: nowrap; color: ${labelColor}` : "white-space: nowrap";
    output.push(`## ${candidate.title} <span style="${labelStyle}">${escapeHtml(labelText)}</span>`);
    index += 2;
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function inlineColor(value: string): string | null {
  const match = /^<span style="color:\s*([^"]+)">[^<]*<\/span>$/.exec(value.trim());
  return match ? safeCssColor(match[1]!) : null;
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
