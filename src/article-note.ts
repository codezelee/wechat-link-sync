import type { CaptureSummary } from "./contracts.js";
import type { ArticleInboxSettings, ParsedArticle } from "./models.js";
import { yamlString } from "./path-utils.js";

export function buildArticleContent(
  capture: CaptureSummary,
  article: ParsedArticle,
  settings: ArticleInboxSettings,
  importedAt = new Date().toISOString()
): string {
  const tags = [...new Set([...capture.tags, ...(article.sourceTags ?? [])].map((tag) => tag.trim()).filter(Boolean))];
  const rows = [
    "---",
    `capture_id: ${yamlString(capture.id)}`,
    "type: web-article",
    `title: ${yamlString(article.title)}`,
    ...(article.author ? [`author: ${yamlString(article.author)}`] : []),
    `source: ${yamlString(capture.originalUrl)}`,
    `source_domain: ${yamlString(new URL(capture.originalUrl).hostname)}`,
    ...(article.publishedAt ? [`published_at: ${yamlString(article.publishedAt)}`] : []),
    ...(article.description ? [`description: ${yamlString(article.description)}`] : []),
    `captured_at: ${yamlString(capture.createdAt)}`,
    `imported_at: ${yamlString(importedAt)}`,
    `extractor: ${yamlString(article.extractor)}`,
    `extractor_version: ${yamlString(article.extractorVersion)}`,
    ...(capture.note && settings.noteLocation === "frontmatter" ? [`note: ${yamlString(capture.note)}`] : []),
    ...(tags.length ? ["tags:", ...tags.map((tag) => `  - ${yamlString(tag)}`)] : ["tags: []"]),
    "---"
  ];
  const callout = capture.note && settings.noteLocation === "callout"
    ? `\n> [!note] 采集备注\n> ${capture.note.replace(/\n/g, "\n> ")}\n`
    : "";
  const title = article.title.replace(/\s+/g, " ").trim();
  return `${rows.join("\n")}\n${callout}\n# ${title}\n\n${article.markdown}\n`;
}

export function captureIdFromMarkdown(markdown: string): string | null {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(markdown)?.[1];
  if (!frontmatter) return null;
  const raw = /^capture_id:\s*(.*?)\s*$/m.exec(frontmatter)?.[1];
  if (!raw) return null;
  return raw.replace(/^(?:"([^"]*)"|'([^']*)')$/, "$1$2");
}
