import {
  PROTOCOL_VERSION,
  type CaptureChange,
  type CaptureCounts,
  type CaptureRemoval,
  type ServerEvent
} from "./contracts.js";
import { PLUGIN_VERSION, type ArticleInboxSettings, type InboxState } from "./models.js";

export class RealtimeClient {
  private socket: WebSocket | undefined;
  private reconnectTimer: number | undefined;
  private attempt = 0;
  private manuallyClosed = false;

  constructor(
    private readonly settings: () => ArticleInboxSettings,
    private readonly onStatus: (status: InboxState["connection"]) => void,
    private readonly onChange: (change: CaptureChange, counts: CaptureCounts) => void,
    private readonly onRemoval: (removal: CaptureRemoval, counts: CaptureCounts) => void,
    private readonly onAuthenticated: () => void
  ) {}

  connect(): void {
    const settings = this.settings();
    if (!settings.deviceToken || !settings.autoConnect) return;
    this.manuallyClosed = false;
    this.clearTimer();
    this.socket?.close();
    this.onStatus("connecting");
    const url = new URL(settings.serverUrl.replace(/\/$/, "") + "/ws");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "auth",
        requestId: crypto.randomUUID(),
        payload: { deviceToken: settings.deviceToken, protocolVersion: PROTOCOL_VERSION, pluginVersion: PLUGIN_VERSION }
      }));
    });
    socket.addEventListener("message", (event) => this.message(event.data));
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (event.code === 4403 || event.code === 4407) this.onStatus("unbound");
      else this.onStatus("disconnected");
      if (!this.manuallyClosed && event.code !== 4403 && event.code !== 4407) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  reconnect(): void { this.disconnect(); this.manuallyClosed = false; this.attempt = 0; this.connect(); }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearTimer();
    this.socket?.close(1000, "client disconnect");
    this.socket = undefined;
  }

  private message(raw: unknown): void {
    try {
      const event = JSON.parse(String(raw)) as ServerEvent;
      if (event.type === "auth.ok") {
        this.attempt = 0;
        this.onStatus("connected");
        this.onAuthenticated();
      } else if (event.type === "capture.changed") {
        this.onChange(event.payload, event.payload.counts);
      } else if (event.type === "captures.removed") {
        this.onRemoval(event.payload, event.payload.counts);
      }
    } catch { /* Ignore invalid or future events; REST remains authoritative. */ }
  }

  private scheduleReconnect(): void {
    const delays = [1, 2, 5, 10, 30, 60];
    const base = delays[Math.min(this.attempt++, delays.length - 1)]! * 1000;
    const jitter = Math.floor(Math.random() * Math.min(1000, base * 0.2));
    this.reconnectTimer = window.setTimeout(() => this.connect(), base + jitter);
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
