/**
 * Universal Real-Time Sync Manager (iPhone iOS <-> Android Проектор)
 * Працює одночасно через 3 канали:
 * 1. Cloud Room Sync (MQTT over WSS через публічний брокер EMQX) — працює між iPhone на 4G/5G та Проектором на Wi-Fi за 4-значним кодом кімнати!
 * 2. LAN WebSocket (коли запущено локальний server.js)
 * 3. BroadcastChannel API (між вкладками одного пристрою)
 */
class SyncManager {
  constructor(onMessageCallback) {
    this.onMessage = onMessageCallback;
    this.clientId = "aura_" + Math.random().toString(36).substring(2, 8);
    this.roomId = this.initRoomId();

    this.bc =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("vj_projector_sync_v2")
        : null;
    this.lanWs = null;
    this.cloudWs = null;
    this.pingInterval = null;
    this.connectTimeout = null;
    this.cloudConnected = false;
    this.lastTelemetrySent = 0;

    // Список надійних WSS MQTT-брокерів з автоматичним перемиканням (Multi-Broker Failover)
    this.brokers = [
      "wss://broker.emqx.io:8084/mqtt",
      "wss://broker.hivemq.com:8884/mqtt",
      "wss://test.mosquitto.org:8081/mqtt",
    ];
    this.brokerIndex = 0;

    if (this.bc) {
      this.bc.onmessage = (e) => {
        if (this.onMessage) this.onMessage(e.data);
      };
    }

    this.connectLanWebSocket();
    this.connectCloudMqtt();

    // Автоматичне відновлення зв'язку після розблокування екрана iPhone або зміни мережі
    window.addEventListener("online", () => {
      if (!this.cloudConnected) this.connectCloudMqtt();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.cloudConnected) {
        this.connectCloudMqtt();
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
    if (!clean) return;
    this.roomId = clean;
    try {
      localStorage.setItem("aura_vj_room", clean);
    } catch {}

    // Якщо WebSocket з брокером вже відкритий, миттєво підписуємося на топік нової кімнати
    if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN && this.cloudConnected) {
      this.cloudWs.send(this.buildMqttSubscribePacket(this.getTopic()));
    } else {
      if (this.cloudWs) {
        try {
          this.cloudWs.close();
        } catch {}
      }
      this.connectCloudMqtt();
    }
    this.notifyStatus();
  }

  getTopic() {
    return `auravj/room/${this.roomId}`;
  }

  /**
   * 1. Хмарна синхронізація через легкий бінарний MQTT 3.1.1 over WSS
   * Дозволяє з'єднати iPhone та Android-проектор з різних мереж із резервуванням брокерів!
   */
  connectCloudMqtt() {
    const brokerUrl = this.brokers[this.brokerIndex % this.brokers.length];
    clearTimeout(this.connectTimeout);
    try {
      if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN) {
        this.cloudWs.close();
      }
      const ws = new WebSocket(brokerUrl, "mqtt");
      ws.binaryType = "arraybuffer";
      this.cloudWs = ws;

      // Якщо брокер не відповів за 4.5 сек — перемикаємось на резервний
      this.connectTimeout = setTimeout(() => {
        if (!this.cloudConnected && this.cloudWs === ws) {
          this.brokerIndex = (this.brokerIndex + 1) % this.brokers.length;
          try {
            ws.close();
          } catch {}
        }
      }, 4500);

      ws.onopen = () => {
        // Відправляємо MQTT CONNECT пакет
        ws.send(this.buildMqttConnectPacket(this.clientId));
      };

      ws.onmessage = (event) => {
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 2) return;
        const packetType = bytes[0] >> 4;

        if (packetType === 2) {
          // CONNACK -> підписуємось на топік кімнати
          clearTimeout(this.connectTimeout);
          this.cloudConnected = true;
          ws.send(this.buildMqttSubscribePacket(this.getTopic()));
          this.notifyStatus();

          clearInterval(this.pingInterval);
          this.pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
            }
          }, 25000);
        } else if (packetType === 3) {
          // PUBLISH пакет від іншого пристрою в кімнаті
          const parsed = this.parseMqttPublishPacket(bytes);
          if (parsed && parsed.sender !== this.clientId && this.onMessage) {
            this.onMessage(parsed);
          }
        }
      };

      ws.onclose = () => {
        const wasConnected = this.cloudConnected;
        this.cloudConnected = false;
        clearInterval(this.pingInterval);
        clearTimeout(this.connectTimeout);
        this.notifyStatus();
        if (!wasConnected) {
          this.brokerIndex = (this.brokerIndex + 1) % this.brokers.length;
        }
        setTimeout(() => {
          if (this.cloudWs === ws) this.connectCloudMqtt();
        }, 2500);
      };

      ws.onerror = () => {};
    } catch {}
  }

  encodeLength(len) {
    const out = [];
    do {
      let digit = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) digit |= 0x80;
      out.push(digit);
    } while (len > 0);
    return out;
  }

  encodeUtf8(str) {
    return new TextEncoder().encode(str);
  }

  buildMqttConnectPacket(clientId) {
    const idBytes = this.encodeUtf8(clientId);
    const varHeader = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c];
    const payload = [idBytes.length >> 8, idBytes.length & 0xff, ...idBytes];
    const remLen = varHeader.length + payload.length;
    return new Uint8Array([0x10, ...this.encodeLength(remLen), ...varHeader, ...payload]);
  }

  buildMqttSubscribePacket(topic) {
    const tBytes = this.encodeUtf8(topic);
    const varHeader = [0x00, 0x01];
    const payload = [tBytes.length >> 8, tBytes.length & 0xff, ...tBytes, 0x00];
    const remLen = varHeader.length + payload.length;
    return new Uint8Array([0x82, ...this.encodeLength(remLen), ...varHeader, ...payload]);
  }

  buildMqttPublishPacket(topic, jsonStr) {
    const tBytes = this.encodeUtf8(topic);
    const pBytes = this.encodeUtf8(jsonStr);
    const remLen = 2 + tBytes.length + pBytes.length;
    const header = [0x30, ...this.encodeLength(remLen), tBytes.length >> 8, tBytes.length & 0xff];
    const out = new Uint8Array(header.length + tBytes.length + pBytes.length);
    out.set(header, 0);
    out.set(tBytes, header.length);
    out.set(pBytes, header.length + tBytes.length);
    return out;
  }

  parseMqttPublishPacket(bytes) {
    try {
      let multiplier = 1;
      let value = 0;
      let idx = 1;
      let encodedByte;
      do {
        encodedByte = bytes[idx++];
        value += (encodedByte & 127) * multiplier;
        multiplier *= 128;
      } while ((encodedByte & 128) !== 0 && idx < 5);

      const topicLen = (bytes[idx] << 8) | bytes[idx + 1];
      const payloadStart = idx + 2 + topicLen;
      const payloadBytes = bytes.subarray(payloadStart);
      const jsonStr = new TextDecoder().decode(payloadBytes);
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  /**
   * 2. Локальний WebSocket (якщо запущено node server.js у локальній мережі)
   */
  connectLanWebSocket() {
    if (
      location.protocol === "file:" ||
      location.hostname.includes("github.io")
    ) {
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws`;

    try {
      this.lanWs = new WebSocket(wsUrl);
      this.lanWs.onopen = () => this.notifyStatus();
      this.lanWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.sender !== this.clientId && this.onMessage) {
            this.onMessage(msg);
          }
        } catch {}
      };
      this.lanWs.onclose = () => {
        setTimeout(() => this.connectLanWebSocket(), 5000);
      };
      this.lanWs.onerror = () => {};
    } catch {}
  }

  send(payload) {
    const packet = { ...payload, sender: this.clientId, room: this.roomId };

    // 1. Локальні вкладки
    if (this.bc) {
      this.bc.postMessage(packet);
    }

    // 2. Локальний Wi-Fi сервер
    const jsonStr = JSON.stringify(packet);
    if (this.lanWs && this.lanWs.readyState === WebSocket.OPEN) {
      this.lanWs.send(jsonStr);
    }

    // 3. Хмарний MQTT (для телеметрії обмежуємо частоту до ~25 пакетів/сек для стабільності 4G)
    if (this.cloudWs && this.cloudWs.readyState === WebSocket.OPEN && this.cloudConnected) {
      if (payload.type === "dspTelemetry") {
        const now = performance.now();
        if (now - this.lastTelemetrySent < 40) return;
        this.lastTelemetrySent = now;
      }
      this.cloudWs.send(this.buildMqttPublishPacket(this.getTopic(), jsonStr));
    }
  }

  notifyStatus() {
    if (this.onMessage) {
      this.onMessage({
        type: "syncStatus",
        connected:
          this.cloudConnected ||
          (this.lanWs && this.lanWs.readyState === WebSocket.OPEN),
        roomId: this.roomId,
      });
    }
  }
}

window.SyncManager = SyncManager;
