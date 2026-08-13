# Privacy / 隐私说明

## 中文

WeChat Link Sync 是由 Obsidian 桌面插件、微信小程序“同步链接”和配套服务组成的链接投递工具。

### 服务会处理的数据

- 用户主动投递的文章 URL
- 用户填写的备注与标签
- 文章标题、作者、发布时间和封面等摘要信息（能够获取时）
- 设备名称、平台、插件版本、匿名设备标识和设备令牌
- 投递记录状态、处理时间和脱敏错误信息

这些数据用于设备绑定、链接队列同步、状态展示、失败重试和回收箱功能。

### 保留在本地的数据

- 从来源网站提取的完整文章正文
- 写入 Vault 的 Markdown 文件
- 下载到 Vault 的文章图片
- Vault 的其他文件与内容

插件处理文章时会直接访问原始文章网站。来源网站会按其自身隐私政策收到正常网页请求所包含的信息，例如 IP 地址、User-Agent 和请求时间。

### 本地处理

使用插件中的“本地处理链接”时，链接不会加入 WeChat Link Sync 服务队列；插件直接请求来源网站并把结果写入当前 Vault。

### 凭据

绑定后获得的设备令牌存放在 Obsidian 的本地插件数据中，用于访问当前用户的链接队列。请勿分享插件数据目录或设备令牌。解除绑定后，该令牌会失效。

## English

WeChat Link Sync consists of an Obsidian desktop plugin, the companion “同步链接” WeChat Mini Program, and a synchronization service.

The service processes URLs explicitly submitted by the user, optional notes and tags, available article metadata, device and plugin information, queue status, timestamps, and sanitized error information. This data is used for device binding, queue synchronization, status display, retries, and trash management.

Full extracted article bodies, Markdown notes, downloaded images, and other vault contents remain on the user's computer. When processing an article, the plugin contacts the source website directly, and that website receives the normal information associated with a web request under its own privacy policy.

Local-only processing does not add the URL to the WeChat Link Sync service queue. The device token is stored in Obsidian's local plugin data and becomes invalid after unbinding.
