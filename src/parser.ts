import DefuddlePackage from "defuddle/full";
import type { DefuddleOptions, DefuddleResponse } from "defuddle";
import TurndownService from "turndown";
import type { ParsedArticle } from "./models.js";
import { extractPublishedAt } from "./published-at.js";

const EXTRACTOR_VERSION = "2.9.0";
const MINIMUM_CONTENT_LENGTH = 40;
const IMAGE_MARKER_PREFIX = "ARTICLEINBOXIMAGE";
const IMAGE_MARKER_SUFFIX = "END";
const UNDERLINE_MARKER_PREFIX = "ARTICLEINBOXUNDERLINE";
const COLOR_MARKER_PREFIX = "ARTICLEINBOXCOLOR";
const FONT_SIZE_MARKER_PREFIX = "ARTICLEINBOXFONTSIZE";
const CENTER_ALIGNMENT_MARKER_PREFIX = "ARTICLEINBOXCENTER";
const BLOCK_STYLE_MARKER_PREFIX = "ARTICLEINBOXBLOCKSTYLE";
const BLOCK_HTML_MARKER_PREFIX = "ARTICLEINBOXBLOCKHTML";
const SAFE_HTML_MARKER_PREFIX = "ARTICLEINBOXSAFEHTML";
const CENTERABLE_BLOCK_SELECTOR = "center, div, figcaption, h1, h2, h3, h4, h5, h6, p, section";
const STYLEABLE_BLOCK_SELECTOR = "address, article, aside, blockquote, div, figcaption, figure, footer, header, li, main, nav, p, section";
const FONT_SIZE_CANDIDATE_SELECTOR = "a, b, code, del, div, em, figcaption, h1, h2, h3, h4, h5, h6, i, ins, kbd, mark, p, s, section, small, span, strong, sub, sup, u";
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
  const markedSafeHtml = isWechat ? [
    ...markRichCodeBlocks(extractionRoot),
    ...markStyledHeadings(extractionRoot),
    ...markInlineCodes(extractionRoot)
  ] : [];
  if (isWechat) preserveWechatSemantics(extractionRoot);
  const markedUnderlines = isWechat ? markUnderlines(extractionRoot) : [];
  const markedColors = isWechat ? markTextColors(extractionRoot) : [];
  const markedFontSizes = isWechat ? markFontSizes(extractionRoot) : [];
  const markedCenterAlignments = isWechat ? markCenterAlignments(extractionRoot) : [];
  const markedBlockHtml = isWechat ? markBlockHtmlElements(extractionRoot) : [];
  const markedBlockStyles = isWechat ? markBlockStyles(extractionRoot) : [];
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
  const restored = restoreBlockStyleMarkers(
    restoreBlockHtmlMarkers(
      restoreCenterAlignmentMarkers(
        restoreFontSizeMarkers(
          restoreTextColorMarkers(
            restoreUnderlineMarkers(
              restoreSafeHtmlMarkers(
                restoreImageMarkers(markdownFromResult(result.contentMarkdown, result.content), markedImages),
                markedSafeHtml
              ),
              markedUnderlines
            ),
            markedColors
          ),
          markedFontSizes
        ),
        markedCenterAlignments
      ),
      markedBlockHtml
    ),
    markedBlockStyles
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

interface MarkedFontSize {
  startMarker: string;
  endMarker: string;
  size: string;
}

interface MarkedCenterAlignment {
  startMarker: string;
  endMarker: string;
}

interface MarkedBlockStyle {
  startMarker: string;
  endMarker: string;
  style: string;
}

interface MarkedBlockHtml {
  startMarker: string;
  endMarker: string;
  openingTag: string;
  closingTag: string;
}

interface MarkedSafeHtml {
  marker: string;
  html: string;
  block: boolean;
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

/**
 * WeChat code cards use one <code> node per visual line and CSS classes for
 * syntax colours. Preserve a small sanitized HTML card before generic Markdown
 * conversion flattens that structure.
 */
function markRichCodeBlocks(root: ParentNode): MarkedSafeHtml[] {
  const containers = [...root.querySelectorAll<HTMLElement>("pre")]
    .filter((pre) => directCodeLines(pre).length > 1)
    .map((pre) => pre.closest<HTMLElement>("section.code-snippet__fix, section[class*='code-snippet']") ?? pre)
    .filter((element, index, all) => all.indexOf(element) === index);

  return containers.map((container, index) => {
    const pre = container.tagName === "PRE" ? container : container.querySelector<HTMLElement>("pre");
    const lines = pre ? directCodeLines(pre) : [];
    const marker = safeHtmlMarker("CODEBLOCK", index);
    const renderedLines = lines.map((line, lineIndex) => {
      const content = [...line.childNodes].map(serializeCodeNode).join("") || " ";
      return `<span style="display: block"><span style="display: inline-block; width: 2.5em; margin-right: 0.75em; color: rgb(198, 198, 198); text-align: right; user-select: none">${lineIndex + 1}</span>${content}</span>`;
    }).join("");
    const html = `<div style="overflow-x: auto; background-color: rgba(0, 0, 0, 0.03); border: 1px solid rgb(240, 240, 240); border-radius: 2px; margin: 1.5em 0"><pre style="margin: 0; padding: 14px; background: transparent; font-family: Menlo, Monaco, &quot;Courier New&quot;, monospace; font-size: 14px; line-height: 1.75; white-space: pre"><code style="font-family: inherit; color: rgb(51, 51, 51); background: transparent; padding: 0">${renderedLines}</code></pre></div>`;
    container.replaceWith(container.ownerDocument.createTextNode(marker));
    return { marker, html, block: true };
  });
}

function directCodeLines(pre: HTMLElement): HTMLElement[] {
  return [...pre.children].filter((child): child is HTMLElement => isHtmlElementNode(child) && child.tagName === "CODE");
}

function serializeCodeNode(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) return escapeHtml((node.textContent ?? "").replace(/\u00a0/g, " "));
  if (!isElementNode(node)) return "";
  if (node.tagName === "BR") return "\n";
  const element = node as HTMLElement;
  const className = typeof element.className === "string" ? element.className : "";
  const styles: string[] = [];
  const paletteColor = declaredTextColor(element) ?? codeSyntaxColor(className);
  if (paletteColor) styles.push(`color: ${paletteColor}`);
  const fontStyle = cssStyleValue(element, "font-style").trim().toLowerCase();
  if (fontStyle === "italic" || /code-snippet__comment/.test(className)) styles.push("font-style: italic");
  const fontWeight = safeInlineFontWeight(element);
  if (fontWeight) styles.push(`font-weight: ${fontWeight}`);
  const content = [...element.childNodes].map(serializeCodeNode).join("");
  return styles.length ? `<span style="${styles.join("; ")}">${content}</span>` : content;
}

function codeSyntaxColor(className: string): string | null {
  if (/code-snippet__comment/.test(className)) return "rgb(175, 175, 175)";
  if (/code-snippet__(?:title|string)/.test(className)) return "rgb(221, 17, 68)";
  if (/code-snippet__(?:variable|number)/.test(className)) return "rgb(14, 156, 229)";
  return null;
}

/** Preserve decorated headings as safe raw HTML so white text keeps its background. */
function markStyledHeadings(root: ParentNode): MarkedSafeHtml[] {
  const candidates = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")]
    .map((element) => ({ element, style: safeHeadingStyle(element, root) }))
    .filter((candidate): candidate is { element: HTMLElement; style: string } => Boolean(candidate.style))
    .filter(({ element }) => Boolean(element.textContent?.trim()));

  return candidates.map(({ element, style }, index) => {
    const marker = safeHtmlMarker("HEADING", index);
    const tag = element.tagName.toLowerCase();
    const content = escapeHtml((element.textContent ?? "").replace(/\s+/g, " ").trim());
    const html = `<${tag} style="${escapeHtml(style)}">${content}</${tag}>`;
    element.replaceWith(element.ownerDocument.createTextNode(marker));
    return { marker, html, block: true };
  });
}

function safeHeadingStyle(element: HTMLElement, root: ParentNode): string | null {
  const declaredBackground = declaredBackgroundColor(element);
  const inheritedBackground = inheritedBackgroundColor(element) ?? "rgb(255, 255, 255)";
  const backgroundColor = declaredBackground && !sameCssColor(declaredBackground, inheritedBackground)
    ? declaredBackground
    : null;
  const fontFamily = safeFontFamily(cssStyleValue(element, "font-family"));
  if (!backgroundColor && !fontFamily) return null;

  const styles: string[] = [];
  const color = declaredTextColor(element);
  const fontSize = declaredFontSize(element);
  const fontWeight = safeInlineFontWeight(element);
  const alignment = effectiveTextAlignment(element, root);
  const display = cssStyleValue(element, "display").trim().toLowerCase();
  const lineHeight = safeLineHeight(cssStyleValue(element, "line-height"));
  const boxShadow = safeBoxShadow(cssStyleValue(element, "box-shadow"));
  if (backgroundColor) styles.push(`background-color: ${backgroundColor}`);
  if (color) styles.push(`color: ${color}`);
  if (fontFamily) styles.push(`font-family: ${fontFamily}`);
  if (fontSize) styles.push(`font-size: ${fontSize}`);
  if (fontWeight) styles.push(`font-weight: ${fontWeight}`);
  if (/^(?:left|right|center|justify)$/.test(alignment ?? "")) styles.push(`text-align: ${alignment}`);
  if (/^(?:block|inline-block|table)$/.test(display)) styles.push(`display: ${display}`);
  if (lineHeight) styles.push(`line-height: ${lineHeight}`);
  styles.push(...safeBoxDeclaration("padding", cssStyleValue(element, "padding"), 160));
  styles.push(...safeBoxDeclaration("border-radius", cssStyleValue(element, "border-radius"), 80));
  styles.push(...safeMarginDeclaration(cssStyleValue(element, "margin"), 160));
  if (boxShadow) styles.push(`box-shadow: ${boxShadow}`);
  if (display === "table") styles.push("max-width: 100%", "box-sizing: border-box", "overflow-wrap: anywhere");
  return styles.join("; ");
}

/** Inline code stays HTML when it carries foreground/background/font styles. */
function markInlineCodes(root: ParentNode): MarkedSafeHtml[] {
  return [...root.querySelectorAll<HTMLElement>("code")]
    .filter((element) => !element.closest("pre"))
    .filter((element) => Boolean(element.textContent))
    .map((element, index) => {
      const marker = safeHtmlMarker("INLINECODE", index);
      const style = safeInlineCodeStyle(element);
      const html = `<code${style ? ` style="${escapeHtml(style)}"` : ""}>${escapeHtml((element.textContent ?? "").replace(/\u00a0/g, " "))}</code>`;
      element.replaceWith(element.ownerDocument.createTextNode(marker));
      return { marker, html, block: false };
    });
}

function safeInlineCodeStyle(element: HTMLElement): string {
  const styles: string[] = [];
  const color = declaredTextColor(element);
  const backgroundColor = declaredBackgroundColor(element);
  const fontFamily = safeFontFamily(cssStyleValue(element, "font-family"));
  const fontSize = declaredFontSize(element);
  if (color) styles.push(`color: ${color}`);
  if (backgroundColor) styles.push(`background-color: ${backgroundColor}`);
  if (fontFamily) styles.push(`font-family: ${fontFamily}`);
  if (fontSize) styles.push(`font-size: ${fontSize}`);
  styles.push(...safeBoxDeclaration("padding", cssStyleValue(element, "padding"), 40));
  styles.push(...safeBoxDeclaration("border-radius", cssStyleValue(element, "border-radius"), 40));
  return styles.join("; ");
}

function safeHtmlMarker(kind: string, index: number): string {
  return `${SAFE_HTML_MARKER_PREFIX}${kind}${String(index + 1).padStart(6, "0")}END`;
}

function preserveInlineBold(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    if (element.closest("pre, code")) return;
    if (element.closest("strong, b")) return;
    const weight = cssStyleValue(element, "font-weight").trim().toLowerCase();
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
    .filter(({ element }) => !element.closest("pre, code"))
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
  const weight = cssStyleValue(element, "font-weight").trim().toLowerCase();
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
    .filter(({ element }) => !element.closest("pre, code"))
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

function markFontSizes(root: ParentNode): MarkedFontSize[] {
  const candidates = [...root.querySelectorAll<HTMLElement>(FONT_SIZE_CANDIDATE_SELECTOR)]
    .map((element) => ({ element, size: effectiveFontSize(element, root) }))
    .filter((candidate): candidate is { element: HTMLElement; size: string } => Boolean(candidate.size))
    .filter(({ element }) => !element.closest("pre, code"))
    .filter(({ size }) => !sameFontSize(size, "16px"))
    .filter(({ element }) => Boolean(element.textContent?.trim()))
    .filter(({ element }) => isFontSizeLeaf(element))
    .filter(({ element, size }) => {
      if (!isInlineElement(element)) return true;
      const declared = declaredFontSize(element);
      return Boolean(declared && !sameFontSize(declared, inheritedFontSize(element, root) ?? "16px") && sameFontSize(declared, size));
    });

  return candidates.map(({ element, size }, index) => {
    const markerId = String(index + 1).padStart(6, "0");
    const startMarker = `${FONT_SIZE_MARKER_PREFIX}${markerId}START`;
    const endMarker = `${FONT_SIZE_MARKER_PREFIX}${markerId}END`;
    element.prepend(element.ownerDocument.createTextNode(startMarker));
    element.append(element.ownerDocument.createTextNode(endMarker));
    return { startMarker, endMarker, size };
  });
}

function isFontSizeLeaf(element: HTMLElement): boolean {
  if (isInlineElement(element)) return true;
  return !element.querySelector(CENTERABLE_BLOCK_SELECTOR)
    && !element.querySelector("img, ol, pre, table, ul");
}

function effectiveFontSize(element: HTMLElement, root: ParentNode): string | null {
  let current: HTMLElement | null = element;
  while (current) {
    const size = declaredFontSize(current);
    if (size) return size;
    if (current === root) break;
    current = current.parentElement;
  }
  return null;
}

function inheritedFontSize(element: HTMLElement, root: ParentNode): string | null {
  let parent = element.parentElement;
  while (parent) {
    const size = declaredFontSize(parent);
    if (size) return size;
    if (parent === root) break;
    parent = parent.parentElement;
  }
  return null;
}

function declaredFontSize(element: HTMLElement): string | null {
  return safeFontSize(cssStyleValue(element, "font-size"));
}

function safeFontSize(value: string): string | null {
  const size = value.trim().toLowerCase();
  const match = /^((?:\d+(?:\.\d+)?)|(?:\.\d+))(px|em|rem|%)$/.exec(size);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount)) return null;
  if (unit === "px" && amount >= 8 && amount <= 72) return `${amount}px`;
  if ((unit === "em" || unit === "rem") && amount >= 0.5 && amount <= 4) return `${amount}${unit}`;
  if (unit === "%" && amount >= 50 && amount <= 400) return `${amount}%`;
  return null;
}

function sameFontSize(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
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
  const inline = cssStyleValue(element, "text-align").toLowerCase();
  if (inline) return inline;
  const legacy = element.getAttribute("align")?.trim().toLowerCase();
  if (legacy) return legacy;
  return element.tagName === "CENTER" ? "center" : null;
}

function markBlockHtmlElements(root: ParentNode): MarkedBlockHtml[] {
  const elements = [...root.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, strong, b, em, i, del, s, code")]
    .filter((element) => isInsideStyledBlock(element, root))
    .sort((left, right) => elementDepth(right) - elementDepth(left));

  return elements.map((element, index) => {
    const markerId = String(index + 1).padStart(6, "0");
    const startMarker = `${BLOCK_HTML_MARKER_PREFIX}${markerId}START`;
    const endMarker = `${BLOCK_HTML_MARKER_PREFIX}${markerId}END`;
    const tag = safeBlockHtmlTag(element.tagName);
    const parent = element.parentNode;
    if (!parent) return { startMarker, endMarker, openingTag: "", closingTag: "" };
    parent.insertBefore(element.ownerDocument.createTextNode(startMarker), element);
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    parent.insertBefore(element.ownerDocument.createTextNode(endMarker), element);
    element.remove();
    return { startMarker, endMarker, openingTag: `<${tag}>`, closingTag: `</${tag}>` };
  });
}

function isInsideStyledBlock(element: HTMLElement, root: ParentNode): boolean {
  let parent = element.parentElement;
  while (parent) {
    if (safeBlockStyle(parent)) return true;
    if (parent === root) break;
    parent = parent.parentElement;
  }
  return false;
}

function elementDepth(element: Element): number {
  let depth = 0;
  let parent = element.parentElement;
  while (parent) {
    depth += 1;
    parent = parent.parentElement;
  }
  return depth;
}

function safeBlockHtmlTag(tagName: string): string {
  const tag = tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return tag;
  if (tag === "strong" || tag === "b") return "strong";
  if (tag === "em" || tag === "i") return "em";
  if (tag === "del" || tag === "s") return "del";
  return tag === "code" ? "code" : "p";
}

function markBlockStyles(root: ParentNode): MarkedBlockStyle[] {
  const candidates = [...root.querySelectorAll<HTMLElement>(STYLEABLE_BLOCK_SELECTOR)]
    .map((element) => ({ element, style: safeBlockStyle(element) }))
    .filter((candidate): candidate is { element: HTMLElement; style: string } => Boolean(candidate.style))
    .filter(({ element }) => Boolean(element.textContent?.trim()));

  return candidates.map(({ element, style }, index) => {
    const markerId = String(index + 1).padStart(6, "0");
    const startMarker = `${BLOCK_STYLE_MARKER_PREFIX}${markerId}START`;
    const endMarker = `${BLOCK_STYLE_MARKER_PREFIX}${markerId}END`;
    element.prepend(element.ownerDocument.createTextNode(startMarker));
    element.append(element.ownerDocument.createTextNode(endMarker));
    return { startMarker, endMarker, style };
  });
}

function safeBlockStyle(element: HTMLElement): string | null {
  const declaredBackground = declaredBackgroundColor(element);
  const inheritedBackground = inheritedBackgroundColor(element) ?? "rgb(255, 255, 255)";
  const backgroundColor = declaredBackground && !sameCssColor(declaredBackground, inheritedBackground)
    ? declaredBackground
    : null;
  const borderLeft = safeLeftBorder(element);
  if (!backgroundColor && !borderLeft) return null;

  const styles = [
    ...(backgroundColor ? [`background-color: ${backgroundColor}`] : []),
    ...(borderLeft ? [`border-left: ${borderLeft}`] : []),
    ...safeBoxDeclaration("padding", cssStyleValue(element, "padding"), 160),
    ...safeBoxDeclaration("border-radius", cssStyleValue(element, "border-radius"), 80),
    ...safeBoxDeclaration("margin", cssStyleValue(element, "margin"), 160)
  ];
  return styles.join("; ");
}

function declaredBackgroundColor(element: HTMLElement): string | null {
  return safeCssColor(cssStyleValue(element, "background-color"))
    ?? safeCssColor(cssStyleValue(element, "background"));
}

function inheritedBackgroundColor(element: HTMLElement): string | null {
  let parent = element.parentElement;
  while (parent) {
    const color = declaredBackgroundColor(parent);
    if (color) return color;
    parent = parent.parentElement;
  }
  return null;
}

function safeLeftBorder(element: HTMLElement): string | null {
  const shorthand = cssStyleValue(element, "border-left");
  const shorthandMatch = /^(\S+)\s+(solid|dashed|dotted|double)\s+(.+)$/i.exec(shorthand);
  const width = safeCssLength(cssStyleValue(element, "border-left-width") || shorthandMatch?.[1] || "", 12);
  const style = (cssStyleValue(element, "border-left-style") || shorthandMatch?.[2] || "").trim().toLowerCase();
  const color = safeCssColor(cssStyleValue(element, "border-left-color") || shorthandMatch?.[3] || "");
  if (!width || width === "0" || !/^(?:solid|dashed|dotted|double)$/.test(style) || !color) return null;
  return `${width} ${style} ${color}`;
}

function cssStyleValue(element: HTMLElement, property: string): string {
  const parsed = element.style.getPropertyValue(property).trim();
  if (parsed) return parsed;
  const declarations = element.getAttribute("style")?.split(";") ?? [];
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 0 || declaration.slice(0, separator).trim().toLowerCase() !== property) continue;
    return declaration.slice(separator + 1).trim();
  }
  return "";
}

function safeBoxDeclaration(property: string, value: string, maxPixels: number): string[] {
  const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 4) return [];
  const safeParts = parts.map((part) => safeCssLength(part, maxPixels));
  return safeParts.every((part): part is string => Boolean(part))
    ? [`${property}: ${safeParts.join(" ")}`]
    : [];
}

function safeMarginDeclaration(value: string, maxPixels: number): string[] {
  const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 4) return [];
  const safeParts = parts.map((part) => part === "auto" ? "auto" : safeCssLength(part, maxPixels));
  return safeParts.every((part): part is string => Boolean(part))
    ? [`margin: ${safeParts.join(" ")}`]
    : [];
}

function safeFontFamily(value: string): string | null {
  const family = value.trim();
  if (!family || family.length > 240 || !/^[\p{L}\p{N}\s"',.-]+$/u.test(family)) return null;
  const parts = family.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 12) return null;
  return parts.every((part) => /^[-\p{L}\p{N}\s"']+$/u.test(part)) ? parts.join(", ") : null;
}

function safeLineHeight(value: string): string | null {
  const lineHeight = value.trim().toLowerCase();
  if (!lineHeight) return null;
  if (/^\d+(?:\.\d+)?$/.test(lineHeight)) {
    const amount = Number(lineHeight);
    return amount >= 0.8 && amount <= 4 ? String(amount) : null;
  }
  return safeCssLength(lineHeight, 120);
}

function safeBoxShadow(value: string): string | null {
  const shadow = value.trim().toLowerCase();
  const match = /^((?:rgba?|hsla?)\([0-9.,%\s-]+\)|#[0-9a-f]{3,8}|[a-z]+)\s+(.+)$/.exec(shadow);
  if (!match || !safeCssColor(match[1]!)) return null;
  const parts = match[2]!.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return null;
  const lengths = parts.filter((part) => part !== "inset");
  if (lengths.length < 2 || lengths.length > 4) return null;
  if (!lengths.every((part) => safeShadowLength(part))) return null;
  return `${match[1]} ${parts.join(" ")}`;
}

function safeShadowLength(value: string): boolean {
  const match = /^(-?(?:(?:\d+(?:\.\d+)?)|(?:\.\d+)))(px|em|rem)?$/.exec(value);
  if (!match) return false;
  return Math.abs(Number(match[1])) <= 160;
}

function safeCssLength(value: string, maxPixels: number): string | null {
  const length = value.trim().toLowerCase();
  if (length === "0" || length === "0px") return "0";
  const match = /^((?:\d+(?:\.\d+)?)|(?:\.\d+))(px|em|rem|%)$/.exec(length);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount)) return null;
  if (unit === "px" && amount <= maxPixels) return `${amount}px`;
  if ((unit === "em" || unit === "rem") && amount <= 10) return `${amount}${unit}`;
  if (unit === "%" && amount <= 50) return `${amount}%`;
  return null;
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
    if (!isElementNode(node)) return;
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

function isElementNode(node: Node): node is Element {
  const obsidianNode = node as Node & { instanceOf?: NodeInstanceOf };
  return typeof obsidianNode.instanceOf === "function"
    ? obsidianNode.instanceOf(Element)
    : node.nodeType === 1;
}

function isHtmlElementNode(node: Node): node is HTMLElement {
  const obsidianNode = node as Node & { instanceOf?: NodeInstanceOf };
  return typeof obsidianNode.instanceOf === "function"
    ? obsidianNode.instanceOf(HTMLElement)
    : isElementNode(node) && node.namespaceURI === "http://www.w3.org/1999/xhtml";
}

type NodeInstanceOf = <T>(type: { new(): T }) => boolean;

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

function restoreSafeHtmlMarkers(markdown: string, elements: MarkedSafeHtml[]): string {
  let restored = markdown;
  for (const element of elements) {
    const replacement = element.block ? `\n\n${element.html}\n\n` : element.html;
    restored = restored.split(element.marker).join(replacement);
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

function restoreFontSizeMarkers(markdown: string, sizes: MarkedFontSize[]): string {
  let restored = markdown;
  for (const size of sizes) {
    restored = restored
      .split(size.startMarker).join(`<span style="font-size: ${size.size}">`)
      .split(size.endMarker).join("</span>");
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

function restoreBlockStyleMarkers(markdown: string, blocks: MarkedBlockStyle[]): string {
  let restored = markdown;
  for (const block of blocks) {
    restored = restored
      .split(block.startMarker).join(`<div style="${block.style}">`)
      .split(block.endMarker).join("</div>");
  }
  return restored;
}

function restoreBlockHtmlMarkers(markdown: string, elements: MarkedBlockHtml[]): string {
  let restored = markdown;
  for (const element of elements) {
    restored = restored
      .split(element.startMarker).join(element.openingTag)
      .split(element.endMarker).join(element.closingTag);
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
