# Changelog

## 1.7.4

- Preserve safe WeChat heading backgrounds, foreground colors, font families, spacing, rounded corners, and shadows so light text remains visible.
- Restore WeChat code cards with line numbers and syntax colors instead of leaking raw HTML tags or flattening the layout.
- Preserve styled inline code and keep mixed font, color, background, and size markup valid in Obsidian reading view.

## 1.7.3

- Modernize the local article URL field with a clearer icon, focus ring, and responsive narrow-sidebar layout.
- Preserve safe WeChat text-block backgrounds, left borders, padding, margins, and rounded corners in Markdown.
- Preserve visually distinct WeChat font sizes for section numbers, headings, emphasized lines, and inherited text.
- Keep background, font-size, alignment, bold, underline, and text-color markup safely composable in Obsidian reading view.

## 1.7.2

- Preserve centered WeChat text blocks declared through `text-align: center`, legacy `align="center"`, or `<center>` markup.
- Retain inherited centering without overriding explicitly left-aligned or justified child paragraphs.
- Keep centered text compatible with existing bold, underline, and color preservation.

## 1.7.1

- Preserve visual underlines represented by CSS text decoration or bottom borders when converting WeChat articles to Markdown.
- Preserve explicit inline text colors while avoiding redundant inherited-color markup.
- Keep bilingual section headings and trailing labels such as `INTERACTIONS` on the same heading line.
- Improve publication-time extraction and local article-processing status handling.

## 1.7.0

- Store the bound device token with Obsidian `SecretStorage` instead of plain-text plugin settings.
- Mask the token in settings and require unbinding before another token can be used.
- Revoke the device token on the server when unbinding, including safe cleanup after partial binding failures.
- Respect WebSocket replacement and rate-limit close codes with controlled reconnect delays.
- Raise the minimum supported Obsidian version to 1.11.4 for `SecretStorage` support.
- Keep the private and public plugin versions synchronized from this release onward.

## 1.6.0

- Initial public release of **WeChat Link Sync**.
- Prepared the plugin as a standalone, independently buildable public repository.
- Added the minimum client protocol types required by the plugin without publishing the Mini Program or backend implementation.
- Added bilingual setup, supported-source, privacy, and screenshot documentation.
- Added official-format validation and release automation for `main.js`, `manifest.json`, and `styles.css`.
- Includes the existing article queue, local processing, binding, status, trash, readable details, stable scrolling, and non-flashing load-more behavior.
