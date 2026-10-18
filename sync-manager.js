/**
 * Real-Time Synchronization Manager (Проектор/Smart TV <-> Смартфон)
 * Працює одночасно через:
 * 1. WebSocket (між різними пристроями в Wi-Fi мережі)
 * 2. BroadcastChannel API (між вкладками без затримок)
 * Передає:
 * - Команди пульта (сцена, XY-тачпад, Strobe, Shockwave, Freeze, Color Drop)
 * - 60 FPS потік аудіо-телеметрії прямо з мікрофона смартфона на проектор!
 */
class SyncManager {
  constructor(onMessageCallback) {
    this.onMessage = onMessageCallback;
    this.ws = null;
    this.bc =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("vj_projector_sync_v2")
        : null;
    this.isConnected = false;
    this.peerCount = 1;

    if (this.bc) {
      this.bc.onmessage = (e) => {
        if (this.onMessage) this.onMessage(e.data);
      };
    }

    this.connectWebSocket();
  }

  connectWebSocket() {
    if (location.protocol === "file:") return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        this.isConnected = true;
        this.notifyStatus(true);
      };
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "peers") {
            this.peerCount = msg.count;
            this.notifyStatus(true);
            return;
          }
          if (this.onMessage) this.onMessage(msg);
        } catch {}
      };
      this.ws.onclose = () => {
        this.isConnected = false;
        this.notifyStatus(false);
        setTimeout(() => this.connectWebSocket(), 3000);
      };
      this.ws.onerror = () => {};
    } catch {}
  }

  send(payload) {
    if (this.bc) {
      this.bc.postMessage(payload);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  notifyStatus(connected) {
    if (this.onMessage) {
      this.onMessage({
        type: "syncStatus",
        connected,
        peerCount: this.peerCount,
      });
    }
  }
}

window.SyncManager = SyncManager;
