import { Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type ArticleInboxPlugin from "./main.js";

export class ArticleInboxSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: ArticleInboxPlugin) { super(plugin.app, plugin); }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();
    containerEl.addClass("article-inbox-settings");
    containerEl.createEl("p", { text: "状态和列表会实时更新；文章只会在你点击“全部处理”或单条“处理”后写入当前 Vault。", cls: "setting-item-description article-inbox-settings-lead" });

    section(containerEl, "连接与绑定", "服务器与当前桌面客户端");
    new Setting(containerEl).setName("服务器地址").setDesc("正式环境应使用 HTTPS，WebSocket 地址会自动派生。")
      .addText((text) => text.setPlaceholder("https://api.example.com").setValue(settings.serverUrl).onChange(async (value) => { settings.serverUrl = value.trim().replace(/\/$/, ""); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("连接测试").setDesc("只检查服务、证书和协议版本，不创建绑定。")
      .addButton((button) => button.setButtonText("测试").onClick(async () => {
        button.setDisabled(true); try { const result = await this.plugin.testConnection(); new Notice(`连接正常 · 协议 v${result.protocolVersion}`); } catch (error) { new Notice(messageOf(error)); } finally { button.setDisabled(false); }
      }));
    new Setting(containerEl).setName("绑定状态").setDesc(
      settings.deviceToken ? `已绑定 · ******** · ${settings.boundAccount || "当前账号"}` : "未绑定"
    );
    if (!settings.deviceToken) {
      let bindingCode = "";
      new Setting(containerEl).setName("一次性绑定码").setDesc("在小程序“设备”页生成，6 位数字，10 分钟有效。")
        .addText((text) => text.setPlaceholder("000000").onChange((value) => { bindingCode = value.replace(/\D/g, "").slice(0, 6); text.setValue(bindingCode); }))
        .addButton((button) => button.setCta().setButtonText("绑定").onClick(async () => {
          if (bindingCode.length !== 6) return new Notice("请输入 6 位绑定码");
          button.setDisabled(true); try { await this.plugin.bind(bindingCode); this.display(); new Notice("设备绑定成功"); } catch (error) { new Notice(messageOf(error)); } finally { button.setDisabled(false); }
        }));
    }
    new Setting(containerEl).setName("设备名称").setDesc("会显示在小程序的消费者设备列表中。")
      .addText((text) => text.setValue(settings.deviceName).onChange((value) => this.plugin.updateDeviceName(value)));
    new Setting(containerEl).setName("WebSocket 自动连接").setDesc("用于实时更新数量和当前文章列表，不会自动处理文章。")
      .addToggle((toggle) => toggle.setValue(settings.autoConnect).onChange(async (value) => { settings.autoConnect = value; await this.plugin.saveSettings(); value ? this.plugin.reconnect() : this.plugin.disconnectRealtime(); }));
    if (settings.deviceToken) {
      new Setting(containerEl).setName("解除绑定").setDesc("撤销本设备令牌并断开实时连接。")
        .addButton((button) => button.setWarning().setButtonText("解除绑定").onClick(() => new ConfirmModal(this.plugin, "解除当前设备绑定？", () => this.plugin.unbind()).open()));
    }

    section(containerEl, "文章处理", "“全部处理”会依次处理所有未处理文章，并自动跳过“不处理”分类");
    new Setting(containerEl).setName("处理结束后打开报告").addToggle((toggle) => toggle.setValue(settings.openReport).onChange(async (value) => { settings.openReport = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("抓取超时").setDesc("10–120 秒。")
      .addText((text) => text.setValue(String(settings.fetchTimeoutSeconds)).onChange(async (value) => { settings.fetchTimeoutSeconds = clamp(value, 10, 120, 30); await this.plugin.saveSettings(); }));

    section(containerEl, "文件与目录", "每篇文章直接保存为该目录下的一个 Markdown 文件");
    textSetting(containerEl, "文章保存目录", "默认 00-同步链接", settings.articleDirectory, async (value) => { settings.articleDirectory = value || "00-同步链接"; await this.plugin.saveSettings(); });
    new Setting(containerEl).setName("图片保存方式").setDesc("统一下载到文章目录下的 ImageSource；所有文章共用该图片文件夹。");
    new Setting(containerEl).setName("文件名规则").setDesc("第一版固定为安全标题；同名追加短采集编号。")
      .addDropdown((dropdown) => dropdown.addOption("safe-title", "安全标题").setValue("safe-title"));
    new Setting(containerEl).setName("用户备注写入位置")
      .addDropdown((dropdown) => dropdown.addOptions({ callout: "正文顶部 Callout", frontmatter: "Frontmatter" }).setValue(settings.noteLocation).onChange(async (value) => { settings.noteLocation = value as typeof settings.noteLocation; await this.plugin.saveSettings(); }));

    section(containerEl, "界面与提醒", "右下角状态栏与轻量反馈");
    toggle(containerEl, "在底部状态栏显示入口", settings.showStatusBar, async (value) => { settings.showStatusBar = value; await this.plugin.saveSettings(); this.plugin.refreshStatusBar(); });
    toggle(containerEl, "显示未处理数量", settings.showPendingCount, async (value) => { settings.showPendingCount = value; await this.plugin.saveSettings(); this.plugin.refreshStatusBar(); });
    toggle(containerEl, "显示处理失败警告", settings.showFailures, async (value) => { settings.showFailures = value; await this.plugin.saveSettings(); this.plugin.refreshStatusBar(); });
    toggle(containerEl, "处理完成短暂提示", settings.completionFlash, async (value) => { settings.completionFlash = value; await this.plugin.saveSettings(); });
    toggle(containerEl, "减少状态动画", settings.reduceMotion, async (value) => { settings.reduceMotion = value; await this.plugin.saveSettings(); this.plugin.refreshStatusBar(); });

    section(containerEl, "高级与诊断", "不导出令牌、正文或 Vault 内容");
    new Setting(containerEl).setName("连接状态").setDesc(this.plugin.diagnosticStatus());
    new Setting(containerEl).setName("重新连接").setDesc("重建 WebSocket 后通过 REST 补查数量。")
      .addButton((button) => button.setButtonText("重新连接").onClick(() => this.plugin.reconnect()));
    new Setting(containerEl).setName("导出诊断信息").setDesc("版本、连接状态与脱敏错误码。")
      .addButton((button) => button.setButtonText("导出").onClick(() => this.plugin.exportDiagnostics()));
  }
}

class ConfirmModal extends Modal {
  constructor(private readonly plugin: ArticleInboxPlugin, private readonly prompt: string, private readonly confirm: () => Promise<void>) { super(plugin.app); }
  onOpen(): void {
    this.contentEl.createEl("h3", { text: this.prompt });
    this.contentEl.createEl("p", { text: "此操作会立即使当前设备令牌失效。" });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const button = actions.createEl("button", { text: "解除绑定", cls: "mod-warning" });
    button.addEventListener("click", () => {
      void (async () => { await this.confirm(); this.close(); this.plugin.settingsTab.display(); })();
    });
  }
}

function section(parent: HTMLElement, title: string, description: string): void { new Setting(parent).setName(title).setHeading().setClass("article-inbox-settings-section"); parent.createEl("p", { text: description, cls: "setting-item-description" }); }
function textSetting(parent: HTMLElement, name: string, description: string, value: string, callback: (value: string) => Promise<void>): void { new Setting(parent).setName(name).setDesc(description).addText((text) => text.setValue(value).onChange((next) => callback(next.trim().replace(/^\/+|\/+$/g, "")))); }
function toggle(parent: HTMLElement, name: string, value: boolean, callback: (value: boolean) => Promise<void>): void { new Setting(parent).setName(name).addToggle((control) => control.setValue(value).onChange(callback)); }
function clamp(value: string, min: number, max: number, fallback: number): number { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function currentPlatform(): "windows" | "macos" { return Platform.isMacOS ? "macos" : "windows"; }
