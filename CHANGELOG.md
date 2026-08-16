# Changelog

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
