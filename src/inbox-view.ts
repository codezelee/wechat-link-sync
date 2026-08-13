import { ItemView, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type { CaptureSummary } from "./contracts.js";
import emptyInboxIllustration from "../assets/empty-inbox.png";
import type ArticleInboxPlugin from "./main.js";
import { captureDetailRows, captureDetailText, formatCaptureTime } from "./capture-detail.js";
import { CAPTURE_STATUS_LABEL, CAPTURE_TAB_ICON, CAPTURE_TAB_ORDER } from "./capture-presentation.js";
import type { InboxTab } from "./models.js";

export const INBOX_VIEW_TYPE = "wechat-link-sync-view";

export class InboxView extends ItemView {
  private unsubscribe?: () => void;
  private localUrl = "";
  private readonly listScrollByTab = new Map<InboxTab, number>();
  private renderedTab?: InboxTab;
  private renderedListLoading = false;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ArticleInboxPlugin) { super(leaf); }
  getViewType(): string { return INBOX_VIEW_TYPE; }
  getDisplayText(): string { return "WeChat Link Sync"; }
  getIcon(): string { return "inbox"; }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.plugin.subscribe(() => this.render());
    await this.plugin.refreshInbox({
      silent: this.plugin.state.captures.length > 0,
      refreshCounts: false
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
  }

  private render(): void {
    const { contentEl } = this;
    const state = this.plugin.state;
    const previousList = contentEl.querySelector<HTMLElement>(".article-inbox-list");
    if (previousList && this.renderedTab && !this.renderedListLoading) {
      this.listScrollByTab.set(this.renderedTab, previousList.scrollTop);
    }
    contentEl.empty();
    contentEl.addClass("article-inbox-view");

    if (state.connection === "disconnected") {
      const banner = contentEl.createDiv({ cls: "article-inbox-banner" });
      setIcon(banner.createSpan(), "cloud-off");
      banner.createSpan({ text: "实时提醒已断开，仍可手动刷新和处理文章" });
      const reconnect = banner.createEl("button", { text: "重连" });
      reconnect.addEventListener("click", () => this.plugin.reconnect());
    } else if (state.connection === "unbound") {
      const banner = contentEl.createDiv({ cls: "article-inbox-banner is-unbound" });
      setIcon(banner.createSpan(), "unlink");
      banner.createSpan({ text: "请先在“选项”中绑定小程序账号" });
    }

    const localCard = contentEl.createDiv({ cls: "article-inbox-local-card" });
    const localText = localCard.createDiv({ cls: "article-inbox-local-copy" });
    localText.createEl("strong", { text: "本地处理链接" });
    localText.createSpan({ text: "直接解析并写入当前 Vault，不会创建或上传服务器记录" });
    const localControls = localCard.createDiv({ cls: "article-inbox-local-controls" });
    const localInput = localControls.createEl("input", {
      type: "url",
      placeholder: "粘贴文章链接",
      value: this.localUrl,
      attr: { "aria-label": "本地处理的文章链接" }
    });
    const processLocal = async (): Promise<void> => {
      if (await this.plugin.processLocalUrl(this.localUrl)) {
        this.localUrl = "";
        this.render();
      }
    };
    localInput.addEventListener("input", () => { this.localUrl = localInput.value; });
    localInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void processLocal(); }
    });
    const paste = localControls.createEl("button", { text: "粘贴" });
    paste.disabled = this.plugin.isLocalLinkProcessing();
    paste.addEventListener("click", () => {
      void (async () => {
        try {
          this.localUrl = await navigator.clipboard.readText();
          localInput.value = this.localUrl;
          localInput.focus();
        } catch { new Notice("无法读取剪贴板，请手动粘贴链接"); }
      })();
    });
    const localAction = localControls.createEl("button", {
      text: this.plugin.isLocalLinkProcessing() ? "处理中…" : "本地处理",
      cls: "mod-cta article-inbox-local-process"
    });
    localAction.disabled = this.plugin.isLocalLinkProcessing() || state.processing;
    localAction.addEventListener("click", () => void processLocal());

    const actionCard = contentEl.createDiv({ cls: "article-inbox-action-card" });
    const refresh = actionCard.createEl("button", {
      cls: "clickable-icon article-inbox-action-refresh",
      attr: { "aria-label": "刷新文章记录", title: "刷新文章记录" }
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.plugin.refreshInbox({
      refreshCounts: true,
      forceCounts: true,
      forceList: true
    }));
    const actionText = actionCard.createDiv({ cls: "article-inbox-action-copy" });
    actionText.createEl("strong", { text: state.processing ? `正在处理 ${state.progressCurrent}/${state.progressTotal}` : "处理全部未处理文章" });
    actionText.createSpan({ text: state.processing
      ? "当前任务完成或安全回滚后停止"
      : state.report
        ? `上批完成：成功 ${state.report.success} · 失败 ${state.report.failed} · 跳过 ${state.report.skipped}`
        : "依次处理全部未处理文章，自动跳过“不处理”分类" });
    const action = actionCard.createEl("button", { cls: `mod-cta article-inbox-primary ${state.processing ? "is-stop" : ""}` });
    setIcon(action.createSpan(), state.processing ? "square" : "send");
    action.createSpan({ text: state.processing ? "停止处理" : "全部处理" });
    action.disabled = !this.plugin.settings.deviceToken || this.plugin.isLocalLinkProcessing();
    action.addEventListener("click", () => { void (state.processing ? this.plugin.stopBatch() : this.plugin.startBatch()); });

    const feedback = actionCard.createDiv({ cls: "article-inbox-feedback" });
    if (state.processing) {
      feedback.addClass("is-progress");
      const progress = feedback.createDiv({ cls: "article-inbox-progress", attr: {
        role: "progressbar",
        "aria-label": "文章处理进度",
        "aria-valuemin": "0",
        "aria-valuemax": String(Math.max(1, state.progressTotal)),
        "aria-valuenow": String(state.progressCurrent)
      } });
      const completed = state.progressTotal > 0 ? state.progressCurrent / state.progressTotal : 0;
      progress.createDiv({ cls: "article-inbox-progress-value" }).style.width = `${Math.min(100, Math.max(0, completed * 100))}%`;
    } else {
      feedback.addClass("is-placeholder");
      feedback.setAttribute("aria-hidden", "true");
    }

    const listHeading = contentEl.createDiv({ cls: "article-inbox-list-heading" });
    const listToolbar = listHeading.createDiv({ cls: "article-inbox-list-toolbar" });
    listToolbar.createEl("strong", { text: "文章记录" });
    const listTools = listToolbar.createDiv({ cls: "article-inbox-list-tools" });
    if (state.activeTab === "trashed") {
      const purgeAll = listTools.createEl("button", { cls: "clickable-icon article-inbox-list-tool is-danger", attr: {
        "aria-label": "永久清空当前回收箱分类",
        title: "永久清空当前回收箱分类"
      } });
      setIcon(purgeAll, "trash-2");
      purgeAll.disabled = !this.plugin.settings.deviceToken || state.processing || this.plugin.tabCount("trashed") === 0;
      purgeAll.addEventListener("click", () => new ConfirmActionModal(
        this.plugin,
        "永久清空回收箱？",
        "回收箱中的服务器推送记录将立即永久清除，无法恢复。当前 Vault 中的 Markdown 和图片不会被删除。",
        "永久清空",
        () => this.plugin.purgeTrash(),
        true
      ).open());
    } else if (state.activeTab !== "processing") {
      const activeTab = state.activeTab;
      const activeLabel = CAPTURE_STATUS_LABEL[activeTab];
      const activeCount = this.plugin.tabCount(activeTab);
      const clearAll = listTools.createEl("button", { cls: "clickable-icon article-inbox-list-tool", attr: {
        "aria-label": `清除当前${activeLabel}分类的全部记录`,
        title: `清除当前${activeLabel}分类的全部记录`
      } });
      setIcon(clearAll, "trash");
      clearAll.disabled = !this.plugin.settings.deviceToken || state.processing || activeCount === 0;
      clearAll.addEventListener("click", () => new ConfirmActionModal(
        this.plugin,
        `清除全部${activeLabel}记录？`,
        `当前“${activeLabel}”分类中的 ${activeCount} 条服务器推送记录将移入回收箱。其他分类不受影响，当前 Vault 中的 Markdown 和图片不会被删除。`,
        "移入回收箱",
        () => this.plugin.trashAllCaptures(activeTab)
      ).open());
    }
    if (!listTools.childElementCount) listTools.remove();
    const tabs = listHeading.createDiv({ cls: "article-inbox-tabs" });
    for (const status of CAPTURE_TAB_ORDER) {
      tab(tabs, status, CAPTURE_STATUS_LABEL[status], this.plugin.tabCount(status), state.activeTab, () => this.plugin.setActiveTab(status));
    }

    const list = contentEl.createDiv({ cls: "article-inbox-list" });
    if (state.listLoading) {
      const loading = list.createDiv({ cls: "article-inbox-empty is-loading" });
      const loadingIcon = loading.createSpan();
      setIcon(loadingIcon, "loader-circle");
      loading.createEl("strong", { text: `正在加载${CAPTURE_STATUS_LABEL[state.activeTab]}文章` });
    } else if (!state.captures.length) {
      const copy = emptyCopy(state.activeTab);
      const empty = list.createDiv({ cls: "article-inbox-empty" });
      const illustration = empty.createEl("img", {
        cls: "article-inbox-empty-illustration",
        attr: { src: emptyInboxIllustration, alt: "" }
      });
      illustration.setAttribute("aria-hidden", "true");
      empty.createEl("strong", { text: copy.title });
      empty.createSpan({ text: copy.description });
    }
    for (const capture of state.captures) {
      const presentation = this.plugin.capturePresentation(capture);
      const displayStatus: InboxTab = capture.status;
      const row = list.createDiv({ cls: `article-inbox-row is-${displayStatus}` });
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.setAttribute("aria-label", `查看${presentation.title}`);
      const icon = row.createDiv({ cls: "article-inbox-cover" });
      renderCover(icon, presentation.coverUrl, presentation.title, statusIcon(displayStatus));
      const main = row.createDiv({ cls: "article-inbox-row-main" });
      main.createEl("strong", { text: presentation.title });
      const sourceLine = main.createSpan({ cls: "article-inbox-row-meta" });
      sourceLine.createSpan({ text: presentation.sourceName, cls: "article-inbox-source-name" });
      sourceLine.createSpan({ text: presentation.sourceHost });
      const infoLine = main.createSpan({ cls: "article-inbox-row-meta" });
      infoLine.createSpan({ text: presentation.author });
      infoLine.createSpan({ text: `${presentation.primaryTimeKind} ${formatCaptureTime(presentation.primaryTime)}` });
      if (capture.status === "failed") main.createSpan({ text: capture.lastErrorMessage ?? "未知错误", cls: "article-inbox-error" });
      const openDetails = () => new CaptureDetailModal(this.plugin, capture, displayStatus).open();
      row.addEventListener("click", openDetails);
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(); }
      });
      const actions = row.createDiv({ cls: "article-inbox-row-actions" });
      if (displayStatus === "trashed") {
        const restore = actions.createEl("button", { text: "恢复", cls: "article-inbox-restore" });
        restore.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.restoreTrashedCapture(capture.id); });
        const purge = actions.createEl("button", { cls: "clickable-icon article-inbox-purge", attr: {
          "aria-label": "永久清除这条记录",
          title: "永久清除这条记录"
        } });
        setIcon(purge, "trash-2");
        purge.addEventListener("click", (event) => {
          event.stopPropagation();
          this.confirmPurge(capture);
        });
      } else if (displayStatus === "pending") {
        const ignore = actions.createEl("button", { text: "不处理", cls: "article-inbox-ignore" });
        ignore.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.ignoreCapture(capture.id); });
        const process = actions.createEl("button", { text: "处理", cls: "mod-cta article-inbox-process" });
        process.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.processPendingCapture(capture.id); });
      } else if (displayStatus === "ignored") {
        const restore = actions.createEl("button", { text: "恢复", cls: "article-inbox-restore" });
        restore.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.restoreIgnoredCapture(capture.id); });
        const process = actions.createEl("button", { text: "处理", cls: "mod-cta article-inbox-process" });
        process.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.processPendingCapture(capture.id); });
      } else if (capture.status === "failed") {
        const retry = actions.createEl("button", { text: "重新处理", cls: "article-inbox-retry" });
        retry.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.retryCapture(capture.id); });
      } else if (capture.status === "processed") {
        const open = actions.createEl("button", { text: "打开文章", cls: "article-inbox-open" });
        open.addEventListener("click", (event) => { event.stopPropagation(); void this.plugin.openLocalCapture(capture.id); });
      }
      if (displayStatus !== "processing" && displayStatus !== "trashed") {
        const clear = actions.createEl("button", { cls: "clickable-icon article-inbox-clear", attr: {
          "aria-label": "清除这条服务器记录",
          title: "清除这条服务器记录"
        } });
        setIcon(clear, "trash");
        clear.addEventListener("click", (event) => {
          event.stopPropagation();
          this.confirmTrash(capture);
        });
      }
      if (!actions.childElementCount) actions.remove();
    }
    if (!state.listLoading && (state.listHasMore || state.listLoadingMore)) {
      const paging = list.createDiv({ cls: "article-inbox-pagination" });
      const more = paging.createEl("button", {
        cls: state.listLoadingMore ? "is-loading" : "",
        attr: { "aria-live": "polite" }
      });
      if (state.listLoadingMore) setIcon(more.createSpan(), "loader-circle");
      more.createSpan({ text: state.listLoadingMore ? "正在加载更多…" : `加载更多（当前 ${state.captures.length} 条）` });
      more.disabled = state.listLoadingMore;
      more.addEventListener("click", () => {
        more.disabled = true;
        more.addClass("is-loading");
        more.empty();
        setIcon(more.createSpan(), "loader-circle");
        more.createSpan({ text: "正在加载更多…" });
        void this.plugin.loadMoreCaptures();
      });
    }
    this.renderedTab = state.activeTab;
    this.renderedListLoading = state.listLoading;
    if (!state.listLoading) {
      list.scrollTop = this.listScrollByTab.get(state.activeTab) ?? 0;
      list.addEventListener("scroll", () => {
        this.listScrollByTab.set(state.activeTab, list.scrollTop);
      }, { passive: true });
    }
  }

  private confirmTrash(capture: CaptureSummary): void {
    new ConfirmActionModal(
      this.plugin,
      "清除这条服务器记录？",
      "记录会移入回收箱并在 3 天后自动永久清除。当前 Vault 中已有的 Markdown 和图片不会被删除。",
      "移入回收箱",
      () => this.plugin.trashCapture(capture.id)
    ).open();
  }

  private confirmPurge(capture: CaptureSummary): void {
    new ConfirmActionModal(
      this.plugin,
      "永久清除这条记录？",
      "这条服务器推送记录将立即永久清除，无法恢复。当前 Vault 中已有的 Markdown 和图片不会被删除。",
      "永久清除",
      () => this.plugin.purgeCapture(capture.id),
      true
    ).open();
  }

}

function tab(parent: HTMLElement, id: InboxTab, label: string, count: number, active: InboxTab, callback: () => void): void {
  const classes = [active === id ? "is-active" : "", id === "processing" && count > 0 ? "has-active-tasks" : ""]
    .filter(Boolean)
    .join(" ");
  const button = parent.createEl("button", { cls: classes });
  button.setAttribute("aria-label", `${label}，${count} 篇`);
  setIcon(button.createSpan({ cls: "article-inbox-tab-icon" }), CAPTURE_TAB_ICON[id]);
  const copy = button.createSpan({ cls: "article-inbox-tab-copy" });
  copy.createSpan({ text: label, cls: "article-inbox-tab-label" });
  copy.createSpan({ text: String(count), cls: "article-inbox-tab-count" });
  button.addEventListener("click", callback);
}

function emptyCopy(status: InboxTab): { title: string; description: string } {
  return ({
    pending: { title: "暂无未处理文章", description: "在小程序中投递链接后，文章会出现在这里" },
    failed: { title: "暂无处理失败记录", description: "处理失败的文章会保留原因，并等待手动重试" },
    processing: { title: "暂无正在处理的文章", description: "领取任务后，可在这里查看处理进度" },
    processed: { title: "暂无已处理文章", description: "处理完成后，可从这里打开本地 Markdown" },
    ignored: { title: "暂无不处理文章", description: "标记为“不处理”的文章会保留在这里" },
    trashed: { title: "回收箱为空", description: "清除的服务器记录会在这里保留 3 天" }
  } as const)[status];
}

class CaptureDetailModal extends Modal {
  constructor(
    private readonly plugin: ArticleInboxPlugin,
    private readonly capture: CaptureSummary,
    private readonly displayStatus: InboxTab
  ) { super(plugin.app); }

  onOpen(): void {
    const presentation = this.plugin.capturePresentation(this.capture);
    this.contentEl.addClass("article-inbox-detail");
    const eyebrow = this.contentEl.createDiv({ cls: `article-inbox-detail-status is-${this.displayStatus}` });
    setIcon(eyebrow.createSpan(), statusIcon(this.displayStatus));
    eyebrow.createSpan({ text: CAPTURE_STATUS_LABEL[this.displayStatus] });
    this.contentEl.createEl("h2", { text: presentation.title });

    const details = this.contentEl.createDiv({ cls: "article-inbox-detail-grid" });
    for (const row of captureDetailRows(this.capture, presentation)) detail(details, row.label, row.value, row.error);

    const source = this.contentEl.createEl("a", {
      text: this.capture.originalUrl,
      cls: "article-inbox-detail-url",
      attr: { href: this.capture.originalUrl, target: "_blank", rel: "noopener noreferrer", draggable: "false" }
    });
    source.setAttribute("title", this.capture.originalUrl);

    const actions = this.contentEl.createDiv({ cls: "modal-button-container article-inbox-detail-actions" });
    const original = actions.createEl("a", {
      text: "打开原文",
      cls: "article-inbox-link-button",
      attr: { href: this.capture.originalUrl, target: "_blank", rel: "noopener noreferrer" }
    });
    const copyDetails = actions.createEl("button", { text: "复制详情" });
    copyDetails.addEventListener("click", () => void copyToClipboard(
      captureDetailText(this.capture, presentation, CAPTURE_STATUS_LABEL[this.displayStatus]),
      "详情已复制"
    ));
    const copyLink = actions.createEl("button", { text: "复制链接" });
    copyLink.addEventListener("click", () => void copyToClipboard(this.capture.originalUrl, "链接已复制"));
    if (this.capture.status === "failed") {
      const retry = actions.createEl("button", { text: "重新处理", cls: "mod-cta" });
      retry.addEventListener("click", () => { this.close(); void this.plugin.retryCapture(this.capture.id); });
    }
    if (this.displayStatus === "pending") {
      const ignore = actions.createEl("button", { text: "不处理" });
      ignore.addEventListener("click", () => { this.close(); void this.plugin.ignoreCapture(this.capture.id); });
      const process = actions.createEl("button", { text: "处理", cls: "mod-cta" });
      process.addEventListener("click", () => { this.close(); void this.plugin.processPendingCapture(this.capture.id); });
    }
    if (this.displayStatus === "ignored") {
      const restore = actions.createEl("button", { text: "恢复为未处理" });
      restore.addEventListener("click", () => { this.close(); void this.plugin.restoreIgnoredCapture(this.capture.id); });
      const process = actions.createEl("button", { text: "处理", cls: "mod-cta" });
      process.addEventListener("click", () => { this.close(); void this.plugin.processPendingCapture(this.capture.id); });
    }
    if (this.capture.status === "processed") {
      const reprocess = actions.createEl("button", { text: "再次处理" });
      reprocess.addEventListener("click", () => {
        this.close();
        new ConfirmActionModal(
          this.plugin,
          "再次处理这篇文章？",
          "插件会重新抓取原文并原位更新同一篇 Markdown 及其正在使用的图片；不会生成第二篇文章。若处理失败，将尽力恢复原文件。",
          "再次处理",
          () => this.plugin.reprocessProcessedCapture(this.capture.id)
        ).open();
      });
      const open = actions.createEl("button", { text: "打开本地文章", cls: "mod-cta" });
      open.addEventListener("click", () => { void this.openLocalCapture(); });
    }
    if (this.displayStatus === "trashed") {
      const restore = actions.createEl("button", { text: "恢复记录" });
      restore.addEventListener("click", () => { this.close(); void this.plugin.restoreTrashedCapture(this.capture.id); });
      if (presentation.writtenPath) {
        const open = actions.createEl("button", { text: "打开本地文章" });
        open.addEventListener("click", () => { void this.openLocalCapture(); });
      }
      const purge = actions.createEl("button", { cls: "clickable-icon article-inbox-danger", attr: {
        "aria-label": "永久清除这条记录",
        title: "永久清除这条记录"
      } });
      setIcon(purge, "trash-2");
      purge.addEventListener("click", () => {
        this.close();
        new ConfirmActionModal(
          this.plugin,
          "永久清除这条记录？",
          "这条服务器推送记录将立即永久清除，无法恢复。当前 Vault 中已有的 Markdown 和图片不会被删除。",
          "永久清除",
          () => this.plugin.purgeCapture(this.capture.id),
          true
        ).open();
      });
    } else if (this.displayStatus !== "processing") {
      const clear = actions.createEl("button", { cls: "clickable-icon", attr: {
        "aria-label": "清除这条服务器记录",
        title: "清除这条服务器记录"
      } });
      setIcon(clear, "trash");
      clear.addEventListener("click", () => {
        this.close();
        new ConfirmActionModal(
          this.plugin,
          "清除这条服务器记录？",
          "记录会移入回收箱并在 3 天后自动永久清除。当前 Vault 中已有的 Markdown 和图片不会被删除。",
          "移入回收箱",
          () => this.plugin.trashCapture(this.capture.id)
        ).open();
      });
    }
    original.setAttribute("role", "button");
  }

  private async openLocalCapture(): Promise<void> {
    if (await this.plugin.openLocalCapture(this.capture.id)) this.close();
  }
}

class ConfirmActionModal extends Modal {
  constructor(
    private readonly plugin: ArticleInboxPlugin,
    private readonly title: string,
    private readonly description: string,
    private readonly confirmLabel: string,
    private readonly action: () => Promise<void>,
    private readonly danger = false
  ) { super(plugin.app); }

  onOpen(): void {
    this.contentEl.addClass("article-inbox-confirm");
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", { text: this.description });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      text: this.confirmLabel,
      cls: this.danger ? "mod-warning article-inbox-danger" : "mod-cta"
    });
    confirm.addEventListener("click", () => {
      void (async () => {
        confirm.disabled = true;
        try { await this.action(); this.close(); }
        finally { confirm.disabled = false; }
      })();
    });
  }
}

function detail(parent: HTMLElement, label: string, value: string, error = false): void {
  parent.createSpan({ text: label, cls: "article-inbox-detail-label" });
  parent.createSpan({ text: value, cls: error ? "article-inbox-detail-value is-error" : "article-inbox-detail-value" });
}

async function copyToClipboard(value: string, successMessage: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); new Notice(successMessage); }
  catch { new Notice("复制失败，请检查系统剪贴板权限"); }
}

function statusIcon(status: InboxTab): string {
  return CAPTURE_TAB_ICON[status];
}

function renderCover(parent: HTMLElement, coverUrl: string | null, title: string, fallbackIcon: string): void {
  if (!coverUrl) { setIcon(parent, fallbackIcon); return; }
  parent.addClass("has-cover");
  const image = parent.createEl("img", {
    attr: { src: coverUrl, alt: `${title}封面`, loading: "lazy", referrerpolicy: "no-referrer" }
  });
  image.addEventListener("error", () => {
    parent.removeClass("has-cover");
    image.remove();
    setIcon(parent, fallbackIcon);
  }, { once: true });
}
