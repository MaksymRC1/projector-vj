/**
 * AURA VJ — High-Performance Local Network (LAN) Sync Engine
 * Забезпечує миттєву синхронізацію (< 1-2 ms) між Ноутбуком, Пультом та Проектором
 * у спільній Wi-Fi / Ethernet мережі роутера через прямий WebSocket.
 *
 * Жодних зовнішніх брокерів, хмарних серверів чи інтернет-затримок!
 */
class SyncManager {
  constructor(onMessageCallback) {
    this.onMessage = onMessageCallback;
    this.clientId = "aura_" + Math.random().toString(36).substring(2, 8);
    this.msgSeq = 0;
    this.roomId = this.initRoomId();

    // 1. Міжвкладковий канал для одного комп'ютера (0 ms)
    this.bc =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("aura_vj_lan_sync")
        : null;

    // 2. Локальний WebSocket (1-2 ms між пристроями по Wi-Fi)
    this.lanWs = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.pingInterval = null;

    this.serverHost = this.resolveServerHost();

    if (this.bc) {
      this.bc.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.sender === this.clientId) return;
        if (msg.room && msg.room !== this.roomId) return;
        if (this.onMessage) this.onMessage(msg);
      };
    }

    this.connectLanWebSocket();

    window.addEventListener("online", () => this.connectLanWebSocket());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.connected) {
        this.connectLanWebSocket();
      }
    });
  }

  initRoomId() {
    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get("room");
    if (urlRoom && urlRoom.trim().length > 0) {
      const clean = urlRoom.trim().toUpperCase();
      try {
        localStorage.setItem("aura_vj_room", clean);
      } catch {}
      return clean;
    }
    try {
      const saved = localStorage.getItem("aura_vj_room");
      if (saved) return saved;
    } catch {}
    const generated = String(Math.floor(1000 + Math.random() * 9000));
    try {
      localStorage.setItem("aura_vj_room", generated);
    } catch {}
    return generated;
  }

  setRoomId(newRoomId) {
    const clean = String(newRoomId).trim().toUpperCase();
    if (!clean || clean === this.roomId) return;
    this.roomId = clean;
    try {
      localStorage.setItem("aura_vj_room", clean);
    } catch {}
    this.notifyStatus();
    this.send({ type: "peerHeartbeat", role: "host", isPing: true });
  }

  resolveServerHost() {
    const params = new URLSearchParams(window.location.search);
    const urlLan = params.get("lan");
    if (urlLan && urlLan.trim().length > 0) {
      const host = urlLan.trim();
      try {
        localStorage.setItem("aura_vj_lan_host", host);
      } catch {}
      return host.includes(":") ? host : `${host}:3456`;
    }

    try {
      const saved = localStorage.getItem("aura_vj_lan_host");
      if (saved) return saved;
    } catch {}

    // Якщо відкрито напряму через http://192.168.x.x:3456 або http://localhost:3456
    if (
      location.protocol.startsWith("http") &&
      !location.hostname.includes("github.io") &&
      location.host
    ) {
      return location.host;
    }

    // Дефолтна IP ноутбука в локальній мережі
    return "192.168.0.40:3456";
  }

  setServerHost(host) {
    if (!host) return;
    const cleanHost = host.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    this.serverHost = cleanHost.includes(":") ? cleanHost : `${cleanHost}:3456`;
    try {
      localStorage.setItem("aura_vj_lan_host", this.serverHost);
    } catch {}

    if (this.lanWs) {
      try {
        this.lanWs.close();
      } catch {}
    }
    this.connectLanWebSocket();
  }

  connectLanWebSocket() {
    clearTimeout(this.reconnectTimer);
    if (this.lanWs && (this.lanWs.readyState === WebSocket.OPEN || this.lanWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const host = this.serverHost;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      this.lanWs = ws;

      ws.onopen = () => {
        this.connected = true;
        this.notifyStatus();
        this.send({ type: "peerHeartbeat", isPing: true });

        clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "ping", sender: this.clientId, room: this.roomId }));
            } catch {}
          }
        }, 10000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (!msg) return;

          // Інформація про кількість підключених клієнтів від сервера
          if (msg.type === "peers") {
            this.notifyStatus(msg.count);
            return;
          }

          if (msg.sender === this.clientId) return;
          if (msg.room && msg.room !== this.roomId) return;

          if (this.onMessage) {
            this.onMessage(msg);
          }
        } catch {}
      };

      ws.onclose = () => {
        this.connected = false;
        clearInterval(this.pingInterval);
        this.notifyStatus();

        this.reconnectTimer = setTimeout(() => {
          this.connectLanWebSocket();
        }, 2000);
      };

      ws.onerror = () => {
        // onclose автоматично запустить reconnectTimer
      };
    } catch {
      this.connected = false;
      this.reconnectTimer = setTimeout(() => this.connectLanWebSocket(), 3000);
    }
  }

  send(payload) {
    const seq = ++this.msgSeq;
    const packet = {
      ...payload,
      sender: this.clientId,
      room: this.roomId,
      seq,
    };

    // 1. Вкладки на тому ж комп'ютері (0 ms)
    if (this.bc) {
      try {
        this.bc.postMessage(packet);
      } catch {}
    }

    // 2. Локальний WebSocket на інші пристрої (Ноутбук -> Проектор по Wi-Fi)
    if (this.lanWs && this.lanWs.readyState === WebSocket.OPEN) {
      try {
        this.lanWs.send(JSON.stringify(packet));
      } catch {}
    }
  }

  notifyStatus(peerCount = null) {
    if (this.onMessage) {
      this.onMessage({
        type: "syncStatus",
        connected: this.connected,
        isLan: true,
        serverHost: this.serverHost,
        roomId: this.roomId,
        peerCount: peerCount,
      });
    }
  }
}

window.SyncManager = SyncManager;
