import { Notice, Plugin, Platform, TFile, apiVersion, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  PROTOCOL_VERSION,
  type CaptureChange,
  type CaptureCounts,
  type CaptureLease,
  type CapturePage,
  type CaptureRemoval,
  type CaptureSummary,
  type ErrorStage,
  type RestorableCaptureStatus
} from "./contracts.js";
import { ApiClient, ApiError } from "./api-client.js";
import { fetchArticlePreview } from "./article-preview.js";
import { fetchAndParse, ProcessingError } from "./article-service.js";
import { buildCapturePresentation, type CapturePresentation } from "./capture-presentation.js";
import { InboxView, INBOX_VIEW_TYPE } from "./inbox-view.js";
import { createLocalCaptureId, createLocalCaptureSummary, normalizeLocalArticleUrl } from "./local-capture.js";
import {
  DEFAULT_SETTINGS,
  PLUGIN_VERSION,
  type ArticleInboxSettings,
  type BatchReport,
  type CapturePreviewRecord,
  type InboxState,
  type InboxTab,
  type LocalCaptureRecord,
  type PendingReport
} from "./models.js";
import { ArticleInboxSettingTab, currentPlatform } from "./settings-tab.js";
import {
  COUNTS_FRESH_MILLISECONDS,
  LIST_CACHE_SIZE,
  LIST_FRESH_MILLISECONDS,
  LIST_PAGE_SIZE
} from "./sync-policy.js";
import { VaultWriter } from "./vault-writer.js";
import { RealtimeClient } from "./ws-client.js";

const EMPTY_COUNTS: CaptureCounts = {
  pendingCount: 0,
  processingCount: 0,
  failedCount: 0,
  processedCount: 0,
  ignoredCount: 0,
  trashedCount: 0,
  revision: 0
};

export default class ArticleInboxPlugin extends Plugin {
  declare settings: ArticleInboxSettings;
  settingsTab!: ArticleInboxSettingTab;
  state: InboxState = {
    counts: { ...EMPTY_COUNTS }, connection: "unbound", processing: false,
    progressCurrent: 0, progressTotal: 0, captures: [], activeTab: "pending", listLoading: false,
    listLoadingMore: false, listNextCursor: null, listHasMore: false
  };
  private api!: ApiClient;
  private realtime!: RealtimeClient;
  private writer!: VaultWriter;
  private statusBar!: HTMLElement;
  private statusIcon!: HTMLSpanElement;
  private statusBadge!: HTMLSpanElement;
  private subscribers = new Set<() => void>();
  private cancelRequested = false;
  private completionTimer?: number;
  private completionVisible = false;
  private lastErrorCode = "";
  private lastHeartbeat = "尚未连接";
  private inboxRequestId = 0;
  private previewRunId = 0;
  private previewInFlight = new Set<string>();
  private countsInFlight: Promise<void> | undefined;
  private lastCountsFetchedAt = 0;
  private listInFlight = new Map<string, Promise<CapturePage>>();
  private lastListFetchedAt = new Map<string, number>();
  private deferredInboxRefresh = false;
  private localLinkProcessing = false;
  private preserveLegacyDeviceToken = false;

  async onload(): Promise<void> {
    const saved = await this.loadData() as (Partial<ArticleInboxSettings> & Record<string, unknown>) | null;
    const current = { ...(saved ?? {}) };
    const legacyDeviceToken = typeof current.deviceToken === "string" ? current.deviceToken.trim() : "";
    delete current.deviceToken;
    const hasRetiredProcessedHistory = [
      "processedHistoryClearedAt",
      "processedHistoryBaselineCount",
      "dismissedProcessedCaptureIds"
    ].some((key) => Object.prototype.hasOwnProperty.call(current, key));
    delete current.byYearMonth;
    delete current.attachmentDirectory;
    delete current.perCaptureAttachments;
    delete current.updateRange;
    delete current.maxBatch;
    delete current.processedHistoryClearedAt;
    delete current.processedHistoryBaselineCount;
    delete current.dismissedProcessedCaptureIds;
    this.settings = { ...DEFAULT_SETTINGS, ...current };
    this.settings.deviceToken = "";
    let secretMigrationCompleted = false;
    try {
      if (legacyDeviceToken) {
        this.app.secretStorage.setSecret(this.settings.deviceTokenSecretId, legacyDeviceToken);
        if (this.app.secretStorage.getSecret(this.settings.deviceTokenSecretId) !== legacyDeviceToken) {
          throw new Error("设备令牌安全存储校验失败");
        }
        this.settings.deviceToken = legacyDeviceToken;
        secretMigrationCompleted = true;
      } else {
        this.settings.deviceToken = this.app.secretStorage.getSecret(this.settings.deviceTokenSecretId) ?? "";
      }
    } catch (error) {
      this.settings.deviceToken = legacyDeviceToken;
      this.preserveLegacyDeviceToken = Boolean(legacyDeviceToken);
      new Notice(`设备令牌迁移失败：${messageOf(error)}`);
    }
    if (typeof this.settings.articleDirectory !== "string" || !this.settings.articleDirectory.trim()) {
      this.settings.articleDirectory = DEFAULT_SETTINGS.articleDirectory;
    }
    if (!Array.isArray(this.settings.captureRecords)) this.settings.captureRecords = [];
    if (!Array.isArray(this.settings.capturePreviews)) this.settings.capturePreviews = [];
    if (!Array.isArray(this.settings.ignoredCaptures)) this.settings.ignoredCaptures = [];
    if (!Array.isArray(this.settings.captureListCaches)) this.settings.captureListCaches = [];
    if (this.settings.deviceName === DEFAULT_SETTINGS.deviceName) {
      this.settings.deviceName = Platform.isMacOS ? "Mac · Obsidian" : "Windows · Obsidian";
    }
    this.restoreCachedList("pending");
    if (hasRetiredProcessedHistory) await this.saveSettings();
    else if (secretMigrationCompleted) await this.saveSettings();
    this.api = new ApiClient(() => this.settings);
    this.writer = new VaultWriter(this.app);
    this.realtime = new RealtimeClient(
      () => this.settings,
      (connection) => { this.state.connection = connection; this.emit(); },
      (change, counts) => this.handleRealtimeChange(change, counts),
      (removal, counts) => this.handleRealtimeRemoval(removal, counts),
      () => {
        this.lastHeartbeat = new Date().toLocaleTimeString();
        void this.handleRealtimeAuthenticated();
      }
    );

    this.registerView(INBOX_VIEW_TYPE, (leaf: WorkspaceLeaf) => new InboxView(leaf, this));
    this.addRibbonIcon("inbox", "WeChat Link Sync", () => { void this.openInbox(); });
    this.createStatusBar();
    this.settingsTab = new ArticleInboxSettingTab(this);
    this.addSettingTab(this.settingsTab);
    this.addCommand({ id: "open-inbox", name: "打开同步链接", callback: () => this.openInbox() });
    this.addCommand({ id: "process-pending", name: "全部处理未处理文章", callback: () => this.startBatch() });
    this.addCommand({ id: "open-local-article-link", name: "打开本地链接处理入口", callback: () => this.openInbox() });
    this.addCommand({ id: "reconnect", name: "重新连接实时提醒", callback: () => this.reconnect() });

    this.app.workspace.onLayoutReady(async () => {
      try { await this.writer.removeEmptyLegacyRoots(); }
      catch (error) { this.remember(error); }
      if (this.settings.deviceToken) {
        await this.flushPendingReports();
        await this.migrateLegacyIgnoredCaptures();
        if (this.settings.autoConnect) this.realtime.connect();
        else {
          await this.refreshCounts({ force: true });
          if (this.subscribers.size) await this.refreshInbox({ silent: true, forceList: true });
        }
      } else {
        this.state.connection = "unbound";
        this.emit();
      }
    });
  }

  onunload(): void {
    this.realtime.disconnect();
    if (this.completionTimer !== undefined) window.clearTimeout(this.completionTimer);
    this.previewRunId += 1;
  }

  async saveSettings(): Promise<void> {
    const persisted: Partial<ArticleInboxSettings> = { ...this.settings };
    if (!this.preserveLegacyDeviceToken) delete persisted.deviceToken;
    if (!this.settings.ignoredCaptures.length) delete persisted.ignoredCaptures;
    await this.saveData(persisted);
  }
  subscribe(callback: () => void): () => void { this.subscribers.add(callback); return () => this.subscribers.delete(callback); }

  async openInbox(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true); await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }

  async refreshCounts(options: { force?: boolean } = {}): Promise<void> {
    if (!this.settings.deviceToken) return;
    if (this.countsInFlight) return this.countsInFlight;
    if (!options.force && Date.now() - this.lastCountsFetchedAt < COUNTS_FRESH_MILLISECONDS) return;

    const task = (async () => {
      try {
        const counts = normalizedCounts(await this.api.counts());
        this.lastCountsFetchedAt = Date.now();
        if (counts.revision >= this.state.counts.revision) this.state.counts = counts;
        this.emit();
      } catch (error) {
        this.remember(error);
        if (error instanceof ApiError && error.status === 401) this.state.connection = "unbound";
        else if (this.state.connection !== "connecting") this.state.connection = "disconnected";
        this.emit();
      }
    })();
    this.countsInFlight = task;
    try { await task; }
    finally { if (this.countsInFlight === task) this.countsInFlight = undefined; }
  }

  async refreshInbox(options: {
    silent?: boolean;
    refreshCounts?: boolean;
    forceCounts?: boolean;
    forceList?: boolean;
    allowClosed?: boolean;
  } = {}): Promise<void> {
    if (!this.settings.deviceToken) {
      this.state.captures = [];
      this.state.listLoading = false;
      this.state.listLoadingMore = false;
      this.state.listNextCursor = null;
      this.state.listHasMore = false;
      this.emit();
      return;
    }
    if (options.refreshCounts) {
      await this.refreshCounts(options.forceCounts === undefined ? {} : { force: options.forceCounts });
    }
    if (!this.subscribers.size && !options.allowClosed) {
      this.deferredInboxRefresh = true;
      return;
    }
    const requestId = ++this.inboxRequestId;
    const activeTab = this.state.activeTab;
    const freshnessKey = activeTab;
    const forceList = options.forceList || this.deferredInboxRefresh;
    if (!forceList && Date.now() - (this.lastListFetchedAt.get(freshnessKey) ?? 0) < LIST_FRESH_MILLISECONDS) {
      return;
    }
    if (!options.silent) {
      this.state.listLoading = true;
      this.emit();
    }
    try {
      const page = await this.fetchCapturePage(activeTab);
      if (requestId === this.inboxRequestId && activeTab === this.state.activeTab) {
        this.state.captures = page.items;
        this.state.listNextCursor = page.nextCursor;
        this.state.listHasMore = page.nextCursor !== null;
        this.deferredInboxRefresh = false;
        this.upsertCaptureListCache(activeTab, page.items);
        await this.saveSettings();
        if (activeTab !== "trashed") void this.hydrateCapturePreviews(page.items);
      }
    } catch (error) { this.remember(error); }
    if (requestId === this.inboxRequestId) this.state.listLoading = false;
    this.emit();
  }

  setActiveTab(tab: InboxTab): void {
    if (this.state.activeTab === tab && !this.state.listLoading) return;
    this.state.activeTab = tab;
    this.state.listLoadingMore = false;
    this.state.listNextCursor = null;
    this.state.listHasMore = false;
    const restored = this.restoreCachedList(tab);
    if (!restored) this.state.captures = [];
    this.emit();
    void this.refreshInbox({ silent: restored, refreshCounts: false });
  }

  async loadMoreCaptures(): Promise<void> {
    const cursor = this.state.listNextCursor;
    if (this.state.listLoading || this.state.listLoadingMore || !this.state.listHasMore || !cursor) return;
    const activeTab = this.state.activeTab;
    this.state.listLoadingMore = true;
    try {
      const page = await this.fetchCapturePage(activeTab, cursor);
      if (activeTab !== this.state.activeTab) return;
      const known = new Set(this.state.captures.map((capture) => capture.id));
      this.state.captures = [...this.state.captures, ...page.items.filter((capture) => !known.has(capture.id))];
      this.state.listNextCursor = page.nextCursor;
      this.state.listHasMore = page.nextCursor !== null;
      if (activeTab !== "trashed") void this.hydrateCapturePreviews(page.items);
    } catch (error) {
      this.remember(error);
    } finally {
      this.state.listLoadingMore = false;
      this.emit();
    }
  }

  capturePresentation(capture: CaptureSummary): CapturePresentation {
    const local = this.localCaptureRecord(capture.id);
    return buildCapturePresentation(capture, local, this.capturePreview(capture.id));
  }

  tabCount(tab: InboxTab): number {
    if (tab === "pending") return this.state.counts.pendingCount;
    return tab === "failed" ? this.state.counts.failedCount
      : tab === "processing" ? this.state.counts.processingCount
      : tab === "processed" ? this.state.counts.processedCount
      : tab === "ignored" ? this.state.counts.ignoredCount
      : this.state.counts.trashedCount;
  }

  async openLocalCapture(captureId: string): Promise<boolean> {
    const file = this.localCaptureFile(captureId);
    if (!file) { new Notice("当前 Vault 中没有找到这篇已处理文章"); return false; }
    await this.app.workspace.getLeaf(false).openFile(file);
    return true;
  }

  isLocalLinkProcessing(): boolean { return this.localLinkProcessing; }

  async processLocalUrl(input: string): Promise<boolean> {
    if (this.state.processing || this.localLinkProcessing) {
      new Notice("请等待当前处理任务结束");
      return false;
    }

    let originalUrl: string;
    try { originalUrl = normalizeLocalArticleUrl(input); }
    catch (error) { new Notice(messageOf(error)); return false; }

    const existing = this.settings.captureRecords.find((record) =>
      record.captureId.startsWith("local-") && record.originalUrl === originalUrl
    );
    if (existing && this.writer.findCapture(existing.captureId)) {
      new Notice(`该链接已保存在：${existing.writtenPath}`);
      return true;
    }

    this.localLinkProcessing = true;
    this.emit();
    try {
      const createdAt = existing?.savedAt ?? new Date().toISOString();
      const capture = createLocalCaptureSummary(originalUrl, existing?.captureId ?? createLocalCaptureId(), createdAt);
      const article = await fetchAndParse(originalUrl, this.settings.fetchTimeoutSeconds);
      const written = await this.writer.write(capture, article, this.settings);
      this.upsertLocalCaptureRecord(capture, article, written.path);
      await this.saveSettings();
      if (written.duplicate) new Notice(`该链接已保存在：${written.path}`);
      else if (written.warnings.length) new Notice(`本地处理完成，含 ${written.warnings.length} 条图片提示`);
      else new Notice("本地处理完成，文章已写入当前 Vault");
      return true;
    } catch (error) {
      this.remember(error);
      new Notice(`本地处理失败：${messageOf(error)}`);
      return false;
    } finally {
      this.localLinkProcessing = false;
      this.emit();
    }
  }

  async startBatch(): Promise<void> {
    if (!this.settings.deviceToken) { new Notice("请先在“选项”中绑定设备"); return; }
    if (this.state.processing || this.localLinkProcessing) { new Notice("请等待当前处理任务结束"); return; }
    this.cancelRequested = false;
    const report: BatchReport = { total: 0, success: 0, failed: 0, skipped: 0, startedAt: Date.now(), finishedAt: 0 };
    this.state.processing = true; delete this.state.report; this.emit();
    try {
      const attempted = new Set<string>();
      while (!this.cancelRequested) {
        const page = await this.api.captures("pending", "all", 100);
        const queue = page.items.filter((capture) => !attempted.has(capture.id));
        if (!queue.length) break;
        report.total += queue.length;
        this.state.progressTotal = report.total;
        this.emit();
        for (const summary of queue) {
          if (this.cancelRequested) break;
          attempted.add(summary.id);
          this.state.progressCurrent += 1; this.emit();
          const outcome = await this.processCapture(summary.id, false);
          report[outcome] += 1;
        }
      }
    } catch (error) {
      this.remember(error); new Notice(messageOf(error));
    } finally {
      report.finishedAt = Date.now();
      this.state.processing = false; this.state.report = report; this.state.progressCurrent = 0; this.state.progressTotal = 0;
      await this.reconcileAfterProcessing();
      this.flashCompletion();
      if (this.settings.openReport && report.total) new Notice(`处理完成：成功 ${report.success}，失败 ${report.failed}，跳过 ${report.skipped}`);
    }
  }

  stopBatch(): void { this.cancelRequested = true; new Notice("将在当前文章安全结束后停止"); }

  async retryCapture(id: string): Promise<void> {
    await this.processSingleCapture(id, true);
  }

  async reprocessProcessedCapture(id: string): Promise<void> {
    if (this.state.processing || this.localLinkProcessing) { new Notice("请等待当前处理任务结束"); return; }
    this.state.processing = true;
    this.state.progressCurrent = 1;
    this.state.progressTotal = 1;
    this.emit();
    try {
      const capture = this.state.captures.find((item) => item.id === id) ?? await this.api.capture(id);
      if (capture.status !== "processed") throw new Error("这条记录已不是已处理状态，请刷新后重试");
      const article = await fetchAndParse(capture.originalUrl, this.settings.fetchTimeoutSeconds);
      const written = await this.writer.rewrite(capture, article, this.settings);
      this.upsertLocalCaptureRecord(capture, article, written.path);
      this.settings.capturePreviews = this.settings.capturePreviews.filter((item) => item.captureId !== id);
      await this.saveSettings();
      new Notice(written.warnings.length ? `再次处理完成，含 ${written.warnings.length} 条图片提示` : "再次处理完成，已更新原文章");
    } catch (error) {
      this.remember(error);
      new Notice(`再次处理失败，原文章已保留：${messageOf(error)}`);
    } finally {
      this.state.processing = false;
      this.state.progressCurrent = 0;
      this.state.progressTotal = 0;
      this.emit();
    }
  }

  async processPendingCapture(id: string): Promise<void> {
    const capture = this.state.captures.find((item) => item.id === id);
    if (capture?.status === "ignored" && !(await this.restoreIgnoredCapture(id, false))) return;
    await this.processSingleCapture(id, false);
  }

  async ignoreCapture(id: string): Promise<void> {
    if (this.state.processing) { new Notice("请等待当前处理任务结束"); return; }
    try {
      const beforeRevision = this.state.counts.revision;
      const capture = await this.api.ignore(id);
      if (this.state.counts.revision === beforeRevision) {
        this.state.counts.pendingCount = Math.max(0, this.state.counts.pendingCount - 1);
        this.state.counts.ignoredCount += 1;
      }
      this.applyCaptureToLists(capture);
      new Notice("已移入“不处理”，全部处理时会自动跳过");
    } catch (error) {
      this.remember(error);
      new Notice(`移入“不处理”失败：${messageOf(error)}`);
    }
  }

  async restoreIgnoredCapture(id: string, notify = true): Promise<boolean> {
    try {
      const beforeRevision = this.state.counts.revision;
      const capture = await this.api.restoreIgnored(id);
      if (this.state.counts.revision === beforeRevision) {
        this.state.counts.ignoredCount = Math.max(0, this.state.counts.ignoredCount - 1);
        this.state.counts.pendingCount += 1;
      }
      this.applyCaptureToLists(capture);
      if (notify) new Notice("已恢复为未处理");
      return true;
    } catch (error) {
      this.remember(error);
      if (notify) new Notice(`恢复失败：${messageOf(error)}`);
      return false;
    }
  }

  async trashCapture(id: string): Promise<void> {
    if (this.state.processing) { new Notice("请等待当前处理任务结束"); return; }
    try {
      const capture = await this.api.trash(id);
      this.applyCaptureToLists(capture);
      await this.saveSettings();
      await this.refreshCounts({ force: true });
      new Notice("已移入回收箱，3 天后自动永久清除；本地文档未删除");
    } catch (error) {
      this.remember(error);
      new Notice(`清除失败：${messageOf(error)}`);
    }
  }

  async trashAllCaptures(status: RestorableCaptureStatus): Promise<void> {
    if (this.state.processing) { new Notice("请等待当前处理任务结束"); return; }
    try {
      const result = await this.api.trashAll(status);
      for (const capture of result.items) this.applyCaptureToLists(capture);
      await this.saveSettings();
      await this.refreshCounts({ force: true });
      new Notice(`已将当前分类的 ${result.movedCount} 条服务器记录移入回收箱；本地文档未删除`);
    } catch (error) {
      this.remember(error);
      new Notice(`全部清除失败：${messageOf(error)}`);
    }
  }

  async restoreTrashedCapture(id: string): Promise<void> {
    try {
      const capture = await this.api.restoreTrashed(id);
      this.applyCaptureToLists(capture);
      await this.saveSettings();
      await this.refreshCounts({ force: true });
      new Notice(`已恢复为${restoredStatusLabel(capture.status)}`);
    } catch (error) {
      this.remember(error);
      new Notice(`恢复失败：${messageOf(error)}`);
    }
  }

  async purgeCapture(id: string): Promise<void> {
    try {
      const result = await this.api.purge(id);
      this.removeServerCaptures(result.captureIds);
      await this.refreshCounts({ force: true });
      new Notice("服务器记录已永久清除；本地文档未删除");
    } catch (error) {
      this.remember(error);
      new Notice(`永久清除失败：${messageOf(error)}`);
    }
  }

  async purgeTrash(): Promise<void> {
    try {
      const result = await this.api.purgeAll();
      this.removeServerCaptures(result.captureIds);
      await this.refreshCounts({ force: true });
      new Notice(`已永久清除 ${result.deletedCount} 条服务器记录；本地文档未删除`);
    } catch (error) {
      this.remember(error);
      new Notice(`清空回收箱失败：${messageOf(error)}`);
    }
  }

  private async processSingleCapture(id: string, retry: boolean): Promise<void> {
    if (this.state.processing || this.localLinkProcessing) { new Notice("请等待当前处理任务结束"); return; }
    this.state.processing = true; this.state.progressCurrent = 1; this.state.progressTotal = 1; this.emit();
    const startedAt = Date.now();
    try {
      const outcome = await this.processCapture(id, retry);
      this.state.report = { total: 1, success: outcome === "success" ? 1 : 0, failed: outcome === "failed" ? 1 : 0, skipped: outcome === "skipped" ? 1 : 0, startedAt, finishedAt: Date.now() };
    } finally {
      this.state.processing = false; this.state.progressCurrent = 0; this.state.progressTotal = 0;
      await this.reconcileAfterProcessing();
      this.flashCompletion();
    }
  }

  async testConnection() { const result = await this.api.health(); if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error("协议版本不兼容"); return result; }

  async bind(code: string): Promise<void> {
    await this.testConnection();
    const result = await this.api.bind(code, this.settings.deviceName, currentPlatform());
    try {
      this.app.secretStorage.setSecret(this.settings.deviceTokenSecretId, result.deviceToken);
      if (this.app.secretStorage.getSecret(this.settings.deviceTokenSecretId) !== result.deviceToken) {
        throw new Error("设备令牌安全存储校验失败");
      }
    } catch (error) {
      try { await this.api.unbind(result.deviceToken); }
      catch (revokeError) { this.remember(revokeError); }
      throw new Error(`绑定未完成：${messageOf(error)}`);
    }
    this.preserveLegacyDeviceToken = false;
    this.settings.deviceToken = result.deviceToken;
    this.settings.deviceId = result.device.id;
    this.settings.boundAccount = `${result.device.userId.slice(0, 4)}••••${result.device.userId.slice(-4)}`;
    await this.saveSettings();
    if (this.settings.autoConnect) {
      this.state.connection = "connecting";
      this.realtime.connect();
    } else {
      await this.refreshCounts({ force: true });
    }
    await this.refreshInbox({ refreshCounts: false, forceList: true });
  }

  async unbind(): Promise<void> {
    try { await this.api.unbind(); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
    this.realtime.disconnect();
    try { this.app.secretStorage.setSecret(this.settings.deviceTokenSecretId, ""); }
    catch (error) { this.remember(error); new Notice("服务器已解绑，但本地安全存储清理失败；旧令牌已在服务器失效"); }
    this.preserveLegacyDeviceToken = false;
    this.settings.deviceToken = "";
    this.settings.deviceId = "";
    this.settings.boundAccount = "";
    this.settings.pendingReports = [];
    this.settings.ignoredCaptures = [];
    this.settings.captureListCaches = [];
    await this.saveSettings();
    this.state = {
      ...this.state,
      counts: { ...EMPTY_COUNTS },
      connection: "unbound",
      captures: [],
      listLoadingMore: false,
      listNextCursor: null,
      listHasMore: false
    };
    this.emit(); new Notice("已解除绑定");
  }

  async updateDeviceName(name: string): Promise<void> {
    this.settings.deviceName = name.trim().slice(0, 100) || "Obsidian Desktop";
    await this.saveSettings();
    if (this.settings.deviceToken) {
      try { await this.api.renameCurrentDevice(this.settings.deviceName); }
      catch (error) { this.remember(error); new Notice("设备名称已保存在本机，服务器更新失败"); }
    }
  }

  reconnect(): void { if (!this.settings.deviceToken) return; this.realtime.reconnect(); }
  disconnectRealtime(): void { this.realtime.disconnect(); this.state.connection = this.settings.deviceToken ? "disconnected" : "unbound"; this.emit(); }
  refreshStatusBar(): void { this.renderStatusBar(); }
  diagnosticStatus(): string { return `REST：${this.settings.deviceToken ? "已配置" : "未绑定"} · WebSocket：${connectionLabel(this.state.connection)} · 协议：v${PROTOCOL_VERSION} · 最近心跳：${this.lastHeartbeat}`; }

  exportDiagnostics(): void {
    const diagnostics = {
      pluginVersion: PLUGIN_VERSION, obsidianApiVersion: apiVersion, platform: Platform.isMacOS ? "macos" : "windows",
      connection: this.state.connection, protocolVersion: PROTOCOL_VERSION, lastHeartbeat: this.lastHeartbeat,
      counts: this.state.counts, pendingReportCount: this.settings.pendingReports.length, lastErrorCode: this.lastErrorCode || null
    };
    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = createEl("a");
    anchor.href = url; anchor.download = `wechat-link-sync-diagnostics-${Date.now()}.json`; anchor.click(); URL.revokeObjectURL(url);
  }

  private async processCapture(id: string, retry: boolean): Promise<"success" | "failed" | "skipped"> {
    let lease: CaptureLease;
    try { lease = retry ? await this.api.retry(id) : await this.api.claim(id); }
    catch (error) {
      if (error instanceof ApiError && error.status === 409) return "skipped";
      this.remember(error); return "failed";
    }

    let leaseValid = true;
    let localWritten = false;
    const renewTimer = window.setInterval(() => {
      void (async () => {
        try { await this.api.renew(lease.id, lease.leaseId); }
        catch (error) { leaseValid = false; this.remember(error); }
      })();
    }, 60_000);

    try {
      const article = await fetchAndParse(lease.originalUrl, this.settings.fetchTimeoutSeconds);
      const written = await this.writer.write(lease, article, this.settings);
      localWritten = true;
      this.upsertLocalCaptureRecord(lease, article, written.path);
      if (!leaseValid) throw new ProcessingError("report", "LEASE_LOST", "处理期间租约已失效，等待下次补报");
      const pending: PendingReport = {
        captureId: lease.id, leaseId: lease.leaseId, writtenPath: written.path,
        extractor: article.extractor, extractorVersion: article.extractorVersion, warnings: written.warnings,
        sourceName: lease.sourceName ?? null,
        title: article.title,
        author: article.author ?? null,
        publishedAt: article.publishedAt ?? null,
        coverUrl: article.images[0]?.url ?? null
      };
      this.settings.pendingReports.push(pending); await this.saveSettings();
      await this.api.complete(pending);
      this.settings.pendingReports = this.settings.pendingReports.filter((item) => item.leaseId !== pending.leaseId);
      await this.saveSettings();
      return "success";
    } catch (error) {
      this.remember(error);
      if (!localWritten) {
        const classified = classify(error);
        try { await this.api.fail(lease.id, lease.leaseId, classified.stage, classified.code, classified.message); }
        catch (reportError) { this.remember(reportError); }
      }
      return "failed";
    } finally { window.clearInterval(renewTimer); }
  }

  private async flushPendingReports(): Promise<void> {
    const retained: PendingReport[] = [];
    for (const report of this.settings.pendingReports) {
      try { await this.api.complete(report); }
      catch (error) {
        if (!(error instanceof ApiError) || (error.status >= 500 || error.status === 0)) retained.push(report);
        this.remember(error);
      }
    }
    this.settings.pendingReports = retained; await this.saveSettings();
  }

  private async reconcileAfterProcessing(): Promise<void> {
    if (this.state.connection === "connected") {
      this.emit();
      return;
    }
    await this.refreshInbox({ refreshCounts: true, forceCounts: true, forceList: true });
  }

  private upsertLocalCaptureRecord(
    capture: CaptureSummary,
    article: { title: string; author?: string; publishedAt?: string; images?: Array<{ url: string }> },
    writtenPath: string
  ): void {
    const record: LocalCaptureRecord = {
      captureId: capture.id,
      originalUrl: capture.originalUrl,
      title: article.title,
      author: article.author ?? null,
      publishedAt: article.publishedAt ?? null,
      coverUrl: article.images?.[0]?.url ?? null,
      writtenPath,
      savedAt: new Date().toISOString()
    };
    this.settings.captureRecords = [record, ...this.settings.captureRecords.filter((item) => item.captureId !== capture.id)];
  }

  private localCaptureRecord(captureId: string): LocalCaptureRecord | undefined {
    const saved = this.settings.captureRecords.find((item) => item.captureId === captureId);
    if (saved) return saved;
    const file = this.writer.findCapture(captureId);
    if (!file) return undefined;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return {
      captureId,
      originalUrl: textValue(frontmatter?.source) ?? "",
      title: textValue(frontmatter?.title) ?? file.basename,
      author: textValue(frontmatter?.author),
      publishedAt: textValue(frontmatter?.published_at),
      coverUrl: null,
      writtenPath: file.path,
      savedAt: textValue(frontmatter?.imported_at) ?? file.stat.mtime.toString()
    };
  }

  private capturePreview(captureId: string): CapturePreviewRecord | undefined {
    return this.settings.capturePreviews.find((item) => item.captureId === captureId);
  }

  private async handleRealtimeAuthenticated(): Promise<void> {
    await this.refreshCounts({ force: true });
    if (this.subscribers.size) await this.refreshInbox({ silent: true, refreshCounts: false, forceList: true });
    else this.deferredInboxRefresh = true;
  }

  private async fetchCapturePage(tab: InboxTab, cursor?: string): Promise<CapturePage> {
    const key = `${tab}:${cursor ?? "first"}`;
    const existing = this.listInFlight.get(key);
    if (existing) return existing;
    const request = this.api.captures(tab, "all", LIST_PAGE_SIZE, cursor);
    this.listInFlight.set(key, request);
    try {
      const page = await request;
      if (!cursor) this.lastListFetchedAt.set(tab, Date.now());
      return page;
    } finally {
      if (this.listInFlight.get(key) === request) this.listInFlight.delete(key);
    }
  }

  private restoreCachedList(tab: InboxTab): boolean {
    const cached = this.settings.captureListCaches.find((item) => item.tab === tab);
    if (!cached?.captures.length) return false;
    this.state.captures = cached.captures;
    this.state.listHasMore = this.tabCount(tab) > cached.captures.length;
    this.state.listNextCursor = this.state.listHasMore ? captureCursor(cached.captures.at(-1)) : null;
    return true;
  }

  private upsertCaptureListCache(tab: InboxTab, captures: CaptureSummary[]): void {
    const record = {
      tab,
      captures: captures.slice(0, LIST_CACHE_SIZE),
      revision: this.state.counts.revision,
      fetchedAt: new Date().toISOString()
    };
    this.settings.captureListCaches = [
      record,
      ...this.settings.captureListCaches.filter((item) => item.tab !== tab)
    ].slice(0, 6);
  }

  private handleRealtimeChange(change: CaptureChange, counts: CaptureCounts): void {
    if (counts.revision < this.state.counts.revision) return;
    this.lastHeartbeat = new Date().toLocaleTimeString();
    this.lastCountsFetchedAt = Date.now();
    this.state.counts = normalizedCounts(counts);
    this.applyCaptureToLists(change.capture);
  }

  private handleRealtimeRemoval(removal: CaptureRemoval, counts: CaptureCounts): void {
    if (counts.revision < this.state.counts.revision) return;
    this.lastHeartbeat = new Date().toLocaleTimeString();
    this.lastCountsFetchedAt = Date.now();
    this.state.counts = normalizedCounts(counts);
    this.removeServerCaptures(removal.captureIds);
  }

  private applyCaptureToLists(capture: CaptureSummary): void {
    const currentLength = Math.max(LIST_PAGE_SIZE, this.state.captures.length);
    const current = this.state.captures.filter((item) => item.id !== capture.id);
    if (capture.status === this.state.activeTab) current.push(capture);
    current.sort(compareCaptures);
    this.state.captures = current.slice(0, currentLength);
    this.state.listHasMore = this.tabCount(this.state.activeTab) > this.state.captures.length;
    this.state.listNextCursor = this.state.listHasMore ? captureCursor(this.state.captures.at(-1)) : null;

    this.settings.captureListCaches = this.settings.captureListCaches.map((cache) => {
      const captures = cache.captures.filter((item) => item.id !== capture.id);
      if (cache.tab === capture.status) captures.push(capture);
      captures.sort(compareCaptures);
      return { ...cache, captures: captures.slice(0, LIST_CACHE_SIZE), revision: this.state.counts.revision };
    });
    this.emit();
  }

  private removeServerCaptures(captureIds: string[]): void {
    if (!captureIds.length) return;
    const removed = new Set(captureIds);
    this.state.captures = this.state.captures.filter((capture) => !removed.has(capture.id));
    this.settings.captureListCaches = this.settings.captureListCaches.map((cache) => ({
      ...cache,
      captures: cache.captures.filter((capture) => !removed.has(capture.id)),
      revision: this.state.counts.revision
    }));
    this.settings.capturePreviews = this.settings.capturePreviews.filter((preview) => !removed.has(preview.captureId));
    this.state.listHasMore = this.tabCount(this.state.activeTab) > this.state.captures.length;
    this.state.listNextCursor = this.state.listHasMore ? captureCursor(this.state.captures.at(-1)) : null;
    void this.saveSettings();
    this.emit();
  }

  private async migrateLegacyIgnoredCaptures(): Promise<void> {
    if (!this.settings.ignoredCaptures.length) return;
    const retained: typeof this.settings.ignoredCaptures = [];
    for (const record of this.settings.ignoredCaptures) {
      try {
        await this.api.ignore(record.capture.id);
      } catch (error) {
        if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 409)) retained.push(record);
      }
    }
    if (retained.length !== this.settings.ignoredCaptures.length) {
      this.settings.ignoredCaptures = retained;
      await this.saveSettings();
    }
  }

  private async hydrateCapturePreviews(captures: CaptureSummary[]): Promise<void> {
    const runId = ++this.previewRunId;
    const queue = captures.filter((capture) => capture.status !== "trashed"
      && this.previewNeedsRefresh(capture)
      && !this.previewInFlight.has(capture.id));
    if (!queue.length) return;
    let cursor = 0;
    let changed = false;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const capture = queue[cursor++];
        if (!capture) return;
        this.previewInFlight.add(capture.id);
        try {
          const preview = await fetchArticlePreview(capture.originalUrl, this.settings.fetchTimeoutSeconds);
          this.upsertCapturePreview({
            captureId: capture.id,
            captureUpdatedAt: capture.updatedAt,
            ...preview,
            fetchedAt: new Date().toISOString(),
            errorMessage: null
          });
        } catch (error) {
          this.upsertCapturePreview({
            captureId: capture.id,
            captureUpdatedAt: capture.updatedAt,
            title: null,
            author: null,
            publishedAt: null,
            coverUrl: null,
            fetchedAt: new Date().toISOString(),
            errorMessage: messageOf(error).slice(0, 300)
          });
        } finally {
          this.previewInFlight.delete(capture.id);
          changed = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
    if (changed) {
      await this.saveSettings();
      if (runId === this.previewRunId && queue.some((capture) => this.state.captures.some((item) => item.id === capture.id))) {
        this.emit();
      }
    }
  }

  private previewNeedsRefresh(capture: CaptureSummary): boolean {
    if (capture.title && capture.author && capture.coverUrl) return false;
    const preview = this.capturePreview(capture.id);
    if (!preview || preview.captureUpdatedAt !== capture.updatedAt) return true;
    const age = Date.now() - new Date(preview.fetchedAt).getTime();
    const lifetime = preview.errorMessage ? 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    return !Number.isFinite(age) || age > lifetime;
  }

  private upsertCapturePreview(record: CapturePreviewRecord): void {
    this.settings.capturePreviews = [
      record,
      ...this.settings.capturePreviews.filter((item) => item.captureId !== record.captureId)
    ].slice(0, 500);
  }

  private localCaptureFile(captureId: string): TFile | null {
    const savedPath = this.settings.captureRecords.find((item) => item.captureId === captureId)?.writtenPath;
    if (savedPath) {
      const saved = this.app.vault.getAbstractFileByPath(savedPath);
      if (saved instanceof TFile) return saved;
    }
    return this.writer.findCapture(captureId);
  }

  private createStatusBar(): void {
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("article-inbox-status");
    this.statusBar.setAttribute("role", "button"); this.statusBar.tabIndex = 0;
    this.statusIcon = this.statusBar.createSpan({ cls: "article-inbox-status-icon" });
    this.statusBadge = this.statusBar.createSpan({ cls: "article-inbox-status-badge" });
    this.statusBar.addEventListener("click", () => { void this.openInbox(); });
    this.statusBar.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void this.openInbox(); } });
    this.renderStatusBar();
  }

  private renderStatusBar(): void {
    if (!this.statusBar) return;
    const pendingCount = this.tabCount("pending");
    this.statusBar.toggleClass("is-hidden", !this.settings.showStatusBar);
    this.statusBar.toggleClass("reduce-motion", this.settings.reduceMotion);
    this.statusBar.removeClass("is-connecting", "is-processing", "is-success", "is-error", "is-offline", "has-pending");
    let icon = "inbox"; let label = "已连接 · 暂无未处理文章"; let badge = "";
    if (!this.settings.deviceToken || this.state.connection === "unbound") { icon = "unlink"; label = "WeChat Link Sync 未绑定"; }
    else if (this.state.processing) { icon = "loader-circle"; label = `正在处理 ${this.state.progressCurrent}/${this.state.progressTotal}`; badge = `${this.state.progressCurrent}/${this.state.progressTotal}`; this.statusBar.addClass("is-processing"); }
    else if (this.completionVisible) { icon = "check-circle-2"; label = "本批处理完成"; this.statusBar.addClass("is-success"); }
    else if (this.state.connection === "connecting") { icon = "loader-circle"; label = "正在连接服务器"; this.statusBar.addClass("is-connecting"); }
    else if (this.state.connection === "disconnected") { icon = "cloud-off"; label = `实时提醒已断开 · 未处理 ${pendingCount}（可能不是最新）`; this.statusBar.addClass("is-offline"); }
    else if (this.settings.showFailures && this.state.counts.failedCount > 0) { icon = "triangle-alert"; label = `未处理 ${pendingCount} · 处理失败 ${this.state.counts.failedCount}`; badge = this.settings.showPendingCount ? countLabel(pendingCount) : ""; this.statusBar.addClass("is-error"); }
    else if (pendingCount > 0) { icon = "inbox"; label = `未处理 ${pendingCount} · 服务器已连接`; badge = this.settings.showPendingCount ? countLabel(pendingCount) : ""; this.statusBar.addClass("has-pending"); }
    setIcon(this.statusIcon, icon); this.statusBadge.setText(badge); this.statusBadge.toggleClass("is-hidden", !badge);
    this.statusBar.setAttribute("aria-label", label); this.statusBar.setAttribute("title", label);
  }

  private flashCompletion(): void {
    if (!this.settings.completionFlash) { this.emit(); return; }
    this.completionVisible = true; this.emit();
    if (this.completionTimer !== undefined) window.clearTimeout(this.completionTimer);
    this.completionTimer = window.setTimeout(() => { this.completionVisible = false; this.emit(); }, 2_000);
  }

  private emit(): void { this.renderStatusBar(); for (const subscriber of this.subscribers) subscriber(); }
  private remember(error: unknown): void { this.lastErrorCode = error instanceof ApiError ? error.code : error instanceof ProcessingError ? error.code : "LOCAL_ERROR"; }
}

function classify(error: unknown): { stage: ErrorStage; code: string; message: string } {
  if (error instanceof ProcessingError) return { stage: error.stage, code: error.code, message: error.message };
  const message = messageOf(error);
  if (message.startsWith("VAULT_WRITE_FAILED")) return { stage: "write", code: "VAULT_WRITE_FAILED", message: message.replace(/^VAULT_WRITE_FAILED:\s*/, "") };
  return { stage: "extract", code: "UNSUPPORTED_PAGE", message };
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function countLabel(count: number): string { return count > 99 ? "99+" : String(count); }
function connectionLabel(value: InboxState["connection"]): string { return ({ unbound: "未绑定", connecting: "连接中", connected: "已连接", disconnected: "已断开" } as const)[value]; }
function normalizedCounts(counts: CaptureCounts): CaptureCounts {
  return { ...counts, trashedCount: counts.trashedCount ?? 0 };
}
function restoredStatusLabel(status: CaptureSummary["status"]): string {
  return ({ pending: "未处理", failed: "处理失败", processed: "已处理", ignored: "不处理" } as Record<string, string>)[status]
    ?? "原分类";
}
function textValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function compareCaptures(left: CaptureSummary, right: CaptureSummary): number {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  return byCreatedAt || right.id.localeCompare(left.id);
}
function captureCursor(capture: CaptureSummary | undefined): string | null {
  if (!capture) return null;
  const bytes = new TextEncoder().encode(JSON.stringify([capture.createdAt, capture.id]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
