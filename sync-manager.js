/**
 * Universal Real-Time Sync Manager (iPhone iOS / Mac / PC <-> Android Проектор / Smart TV)
 * Працює одночасно через 4 синхронні канали з дедуплікацією за seq-номером:
 * 1. BroadcastChannel API (0ms між вкладками/вікнами одного комп'ютера)
 * 2. WebRTC P2P DataChannel (1-15ms прямий UDP-канал між пристроями)
 * 3. LAN WebSocket (1-5ms локальний сервер)
 * 4. Multi-Broker Cloud MQTT Mesh (паралельне з'єднання з EMQX + HiveMQ без split-brain)
 */
class SyncManager {
  constructor(onMessageCallback) {
    this.onMessage = onMessageCallback;
    this.clientId = "aura_" + Math.random().toString(36).substring(2, 8);
    this.msgSeq = 0;
    this.seenControlKeys = new Set();
    this.lastTelemetrySeqBySender = new Map();

    // Акумулятори піків телеметрії між мережевими пакетами (щоб жоден удар бочки не губився)
    this.p2pPeak = null;
    this.mqttPeak = null;
    this.lastTelemetrySentP2P = 0;
    this.lastTelemetrySentMqtt = 0;

    this.roomId = this.initRoomId();
    this.mqttPacketId = 1;

    // 1. Локальний міжвкладковий канал (0ms)
    this.bc =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("vj_projector_sync_v2")
        : null;

    // 2. WebRTC Peer-to-Peer DataChannel (1-15ms UDP)
    this.pc = null;
    this.webrtcChannel = null;
    this.p2pConnected = false;
    this.rtcWatchdog = null;
    this.iceCandidateQueue = [];

    // 3. Локальний WebSocket
    this.lanWs = null;

    // 4. Паралельний пул перевірених хмарних MQTT-брокерів (EMQX + Mosquitto)
    this.brokers = [
      "wss://broker.emqx.io:8084/mqtt",
      "wss://test.mosquitto.org:8081/mqtt",
    ];
    this.cloudConns = new Map();
    this.cloudConnected = false;
    this.connectedBrokerCount = 0;

    if (this.bc) {
      this.bc.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.sender === this.clientId) return;
        // Якщо на цьому ж комп'ютері відкрито пульт із кодом кімнати в URL — автоматично синхронізуємо кімнату
        if (msg.room && msg.room !== this.roomId) {
          this.setRoomId(msg.room, false);
        }
        this.handleIncomingRawMessage(msg);
      };
    }

    // Автоматична синхронізація коду кімнати між вкладками одного браузера через localStorage
    window.addEventListener("storage", (e) => {
      if (e.key === "aura_vj_room" && e.newValue && e.newValue !== this.roomId) {
        this.setRoomId(e.newValue, false);
      }
    });

    this.connectLanWebSocket();
    this.connectCloudMqttMesh();

    window.addEventListener("online", () => {
      this.connectCloudMqttMesh();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.connectCloudMqttMesh();
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

  setRoomId(newRoomId, persist = true) {
    const clean = String(newRoomId).trim().toUpperCase();
    if (!clean || clean === this.roomId) return;
    this.roomId = clean;
    this.closeWebRTC();
    this.lastTelemetrySeqBySender.clear();

    if (persist) {
      try {
        localStorage.setItem("aura_vj_room", clean);
      } catch {}
    }

    const subPacket = this.buildMqttSubscribePacket(this.getTopic());
    let anyOpen = false;
    for (const conn of this.cloudConns.values()) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN && conn.connected) {
        try {
          conn.ws.send(subPacket);
          anyOpen = true;
        } catch {}
      }
    }
    if (!anyOpen) {
      this.connectCloudMqttMesh();
    }
    this.notifyStatus();
    this.sendImmediatePing();
  }

  getTopic() {
    return `auravj/room/${this.roomId}`;
  }

  nextMqttPacketId() {
    this.mqttPacketId = (this.mqttPacketId % 65530) + 1;
    return this.mqttPacketId;
  }

  /**
   * Підключення одночасно до основних публічних MQTT WSS брокерів (Mesh),
   * щоб Пульт і Проектор гарантовано бачили один одного навіть якщо один із брокерів недоступний
   */
  connectCloudMqttMesh() {
    this.brokers.forEach((url, index) => {
      this.ensureBrokerConnection(url, index);
    });
  }

  ensureBrokerConnection(brokerUrl, index) {
    const existing = this.cloudConns.get(brokerUrl);
    if (
      existing &&
      existing.ws &&
      (existing.ws.readyState === WebSocket.OPEN ||
        existing.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const connState = {
      url: brokerUrl,
      ws: null,
      connected: false,
      pingInterval: null,
      connectTimeout: null,
      reconnectTimer: null,
    };
    this.cloudConns.set(brokerUrl, connState);

    try {
      const ws = new WebSocket(brokerUrl, "mqtt");
      ws.binaryType = "arraybuffer";
      connState.ws = ws;

      connState.connectTimeout = setTimeout(() => {
        if (!connState.connected && connState.ws === ws) {
          try {
            ws.close();
          } catch {}
        }
      }, 5000);

      ws.onopen = () => {
        const subClientId = `${this.clientId}_b${index}`;
        try {
          ws.send(this.buildMqttConnectPacket(subClientId));
        } catch {}
      };

      ws.onmessage = (event) => {
        const bytes = new Uint8Array(event.data);
        this.parseMqttStreamFrames(ws, bytes, connState);
      };

      ws.onclose = () => {
        connState.connected = false;
        clearInterval(connState.pingInterval);
        clearTimeout(connState.connectTimeout);
        this.updateCloudConnectedFlag();

        clearTimeout(connState.reconnectTimer);
        connState.reconnectTimer = setTimeout(() => {
          this.ensureBrokerConnection(brokerUrl, index);
        }, 3000);
      };

      ws.onerror = () => {};
    } catch {}
  }

  updateCloudConnectedFlag() {
    let count = 0;
    for (const conn of this.cloudConns.values()) {
      if (conn.connected && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        count++;
      }
    }
    const anyConnected = count > 0;
    const changed =
      this.cloudConnected !== anyConnected ||
      this.connectedBrokerCount !== count;
    this.cloudConnected = anyConnected;
    this.connectedBrokerCount = count;
    if (changed) {
      this.notifyStatus();
    }
  }

  /**
   * Потоковий бінарний парсер MQTT 3.1.1 (коректно обробляє склеєні TCP/WS фрейми)
   */
  parseMqttStreamFrames(ws, bytes, connState) {
    let offset = 0;
    while (offset + 2 <= bytes.length) {
      const headerByte = bytes[offset];
      const packetType = headerByte >> 4;

      let multiplier = 1;
      let remLen = 0;
      let idx = offset + 1;
      let encodedByte;
      let validLength = true;

      do {
        if (idx >= bytes.length) {
          validLength = false;
          break;
        }
        encodedByte = bytes[idx++];
        remLen += (encodedByte & 127) * multiplier;
        multiplier *= 128;
      } while ((encodedByte & 128) !== 0 && idx < offset + 5);

      if (!validLength) break;
      const packetEnd = idx + remLen;
      if (packetEnd > bytes.length) break;

      if (packetType === 2) {
        // CONNACK -> підписуємось на топік кімнати та миттєво сповіщаємо про присутність
        clearTimeout(connState.connectTimeout);
        connState.connected = true;
        this.updateCloudConnectedFlag();

        try {
          ws.send(this.buildMqttSubscribePacket(this.getTopic()));
        } catch {}

        this.sendImmediatePing();

        clearInterval(connState.pingInterval);
        connState.pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
            } catch {}
          }
        }, 25000);
      } else if (packetType === 3) {
        // PUBLISH пакет від іншого пристрою в кімнаті
        if (idx + 2 <= packetEnd) {
          const topicLen = (bytes[idx] << 8) | bytes[idx + 1];
          let payloadStart = idx + 2 + topicLen;
          const qos = (headerByte >> 1) & 0x03;
          if (qos > 0) {
            payloadStart += 2;
          }
          if (payloadStart <= packetEnd) {
            const payloadBytes = bytes.subarray(payloadStart, packetEnd);
            try {
              const jsonStr = new TextDecoder().decode(payloadBytes);
              const parsed = JSON.parse(jsonStr);
              if (parsed && parsed.sender !== this.clientId) {
                this.handleIncomingRawMessage(parsed);
              }
            } catch {}
          }
        }
      }

      offset = packetEnd;
    }
  }

  sendImmediatePing() {
    setTimeout(() => {
      this.send({
        type: "peerHeartbeat",
        isPing: true,
      });
    }, 60);
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
    const pktId = this.nextMqttPacketId();
    const varHeader = [pktId >> 8, pktId & 0xff];
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
      this.lanWs.onopen = () => {
        this.notifyStatus();
        this.sendImmediatePing();
      };
      this.lanWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.sender !== this.clientId) {
            this.handleIncomingRawMessage(msg);
          }
        } catch {}
      };
      this.lanWs.onclose = () => {
        setTimeout(() => this.connectLanWebSocket(), 5000);
      };
      this.lanWs.onerror = () => {};
    } catch {}
  }

  /**
   * 3. WebRTC P2P DataChannel (Ультра-низька затримка 1-15ms через прямий браузер-браузер UDP)
   */
  setupWebRTC(isInitiator, targetPeerId = null) {
    if (typeof RTCPeerConnection === "undefined") return;
    this.closeWebRTC();
    this.iceCandidateQueue = [];
    this.rtcTargetPeer = targetPeerId;

    const config = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
      ],
    };

    try {
      this.pc = new RTCPeerConnection(config);

      // Якщо за 7 секунд P2P не встановився — очищаємо RTCPeerConnection для повторної спроби
      this.rtcWatchdog = setTimeout(() => {
        if (!this.p2pConnected) {
          this.closeWebRTC();
        }
      }, 7000);

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          // Невелика затримка гарантує, що _rtc_offer/answer дійде раніше за _rtc_ice
          setTimeout(() => {
            this.sendSignalingMessage({
              type: "_rtc_ice",
              target: this.rtcTargetPeer,
              candidate: event.candidate,
            });
          }, 35);
        }
      };

      this.pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        const state = this.pc.connectionState;
        if (state === "connected") {
          clearTimeout(this.rtcWatchdog);
        } else if (
          state === "disconnected" ||
          state === "failed" ||
          state === "closed"
        ) {
          this.closeWebRTC();
          this.notifyStatus();
        }
      };

      if (isInitiator) {
        const dc = this.pc.createDataChannel("aura_vj_p2p", {
          ordered: false,
          maxRetransmits: 0,
        });
        this.bindDataChannel(dc);

        this.pc
          .createOffer()
          .then((offer) => this.pc.setLocalDescription(offer))
          .then(() => {
            this.sendSignalingMessage({
              type: "_rtc_offer",
              target: this.rtcTargetPeer,
              sdp: this.pc.localDescription,
            });
          })
          .catch(() => {
            this.closeWebRTC();
          });
      } else {
        this.pc.ondatachannel = (event) => {
          this.bindDataChannel(event.channel);
        };
      }
    } catch {
      this.closeWebRTC();
    }
  }

  bindDataChannel(dc) {
    this.webrtcChannel = dc;
    dc.onopen = () => {
      clearTimeout(this.rtcWatchdog);
      this.p2pConnected = true;
      this.notifyStatus();
    };
    dc.onclose = () => {
      this.p2pConnected = false;
      this.webrtcChannel = null;
      this.notifyStatus();
    };
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && msg.sender !== this.clientId) {
          this.handleIncomingRawMessage(msg);
        }
      } catch {}
    };
  }

  async handleRtcOffer(msg) {
    if (msg.target && msg.target !== this.clientId) return;
    if (this.p2pConnected) return;

    this.setupWebRTC(false, msg.sender);
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      this.processIceQueue();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendSignalingMessage({
        type: "_rtc_answer",
        target: msg.sender,
        sdp: this.pc.localDescription,
      });
    } catch {
      this.closeWebRTC();
    }
  }

  async handleRtcAnswer(msg) {
    if (msg.target && msg.target !== this.clientId) return;
    if (!this.pc || this.pc.signalingState !== "have-local-offer") return;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      this.processIceQueue();
    } catch {
      this.closeWebRTC();
    }
  }

  handleRtcIce(msg) {
    if (msg.target && msg.target !== this.clientId) return;
    if (!msg.candidate) return;
    try {
      const candidate = new RTCIceCandidate(msg.candidate);
      if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
        this.pc.addIceCandidate(candidate).catch(() => {});
      } else {
        if (!this.iceCandidateQueue) this.iceCandidateQueue = [];
        this.iceCandidateQueue.push(candidate);
      }
    } catch {}
  }

  processIceQueue() {
    if (!this.iceCandidateQueue || !this.pc) return;
    while (this.iceCandidateQueue.length > 0) {
      const cand = this.iceCandidateQueue.shift();
      this.pc.addIceCandidate(cand).catch(() => {});
    }
  }

  closeWebRTC() {
    clearTimeout(this.rtcWatchdog);
    if (this.webrtcChannel) {
      try {
        this.webrtcChannel.close();
      } catch {}
      this.webrtcChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }
    this.p2pConnected = false;
  }

  publishToCloudBrokers(jsonStr) {
    const mqttPacket = this.buildMqttPublishPacket(this.getTopic(), jsonStr);
    for (const conn of this.cloudConns.values()) {
      if (conn.connected && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(mqttPacket);
        } catch {}
      }
    }
  }

  sendSignalingMessage(payload) {
    const packet = {
      ...payload,
      sender: this.clientId,
      room: this.roomId,
      seq: ++this.msgSeq,
    };
    const jsonStr = JSON.stringify(packet);
    if (this.bc) this.bc.postMessage(packet);
    if (this.lanWs && this.lanWs.readyState === WebSocket.OPEN) {
      try {
        this.lanWs.send(jsonStr);
      } catch {}
    }
    this.publishToCloudBrokers(jsonStr);
  }

  /**
   * Централізований обробник вхідних повідомлень з усіх каналів із дедуплікацією
   */
  handleIncomingRawMessage(msg) {
    if (!msg || msg.sender === this.clientId) return;
    if (msg.room && msg.room !== this.roomId) return;

    // 1. Для dspTelemetry приймаємо тільки найсвіжіші пакети (щоб повільний MQTT не перекривав швидкий P2P/BC)
    if (msg.type === "dspTelemetry") {
      if (msg.seq) {
        const lastSeq = this.lastTelemetrySeqBySender.get(msg.sender) || 0;
        if (msg.seq <= lastSeq) return;
        this.lastTelemetrySeqBySender.set(msg.sender, msg.seq);
      }
      if (this.onMessage) {
        this.onMessage(msg);
      }
      return;
    }

    // 2. Дедуплікація керуючих та сигнальних пакетів (між EMQX, HiveMQ, WebRTC та BroadcastChannel)
    if (msg.seq) {
      const key = `${msg.sender}:${msg.seq}`;
      if (this.seenControlKeys.has(key)) return;
      this.seenControlKeys.add(key);
      if (this.seenControlKeys.size > 400) {
        const first = this.seenControlKeys.values().next().value;
        this.seenControlKeys.delete(first);
      }
    }

    // 3. WebRTC Сигналізація
    if (msg.type === "_rtc_offer") {
      this.handleRtcOffer(msg);
      return;
    }
    if (msg.type === "_rtc_answer") {
      this.handleRtcAnswer(msg);
      return;
    }
    if (msg.type === "_rtc_ice") {
      this.handleRtcIce(msg);
      return;
    }

    // 4. Автоматичне встановлення P2P каналу при виявленні іншого пристрою в кімнаті
    if (msg.type === "peerHeartbeat" && !this.p2pConnected && !this.pc) {
      if (this.clientId > msg.sender) {
        this.setupWebRTC(true, msg.sender);
      }
    }

    if (this.onMessage) {
      this.onMessage(msg);
    }
  }

  /**
   * Акумуляція піків аудіо-телеметрії між мережевими відправками (Peak-Hold + Beat Latch)
   * Гарантує, що жоден удар бочки (isBeat = 1) або пік басу не буде пропущений тротлером!
   */
  mergeTelemetryPeak(acc, state) {
    if (!acc || !Array.isArray(state)) {
      return Array.isArray(state) ? [...state] : state;
    }
    return [
      Math.max(acc[0] || 0, state[0] || 0), // subBass peak
      Math.max(acc[1] || 0, state[1] || 0), // bass peak
      Math.max(acc[2] || 0, state[2] || 0), // mid peak
      Math.max(acc[3] || 0, state[3] || 0), // high peak
      Math.max(acc[4] || 0, state[4] || 0), // beatIntensity peak
      state[5] || acc[5] || 128,            // bpm
      state[6] ?? acc[6] ?? 0,              // beatPhase
      acc[7] || state[7] ? 1 : 0,           // latched isBeat!
      state[8] ?? acc[8] ?? 0,              // beatCount
      state[9] ?? acc[9] ?? 0,              // accumulatedTime
    ];
  }

  send(payload) {
    const seq = ++this.msgSeq;
    const basePacket = { ...payload, sender: this.clientId, room: this.roomId, seq };

    // 1. Локальні вкладки та вікна на тому ж ПК/Mac (0ms затримки, 60 FPS без тротлінгу)
    if (this.bc) {
      try {
        this.bc.postMessage(basePacket);
      } catch {}
    }

    if (payload.type === "dspTelemetry" && Array.isArray(payload.state)) {
      const now = performance.now();
      this.p2pPeak = this.mergeTelemetryPeak(this.p2pPeak, payload.state);
      this.mqttPeak = this.mergeTelemetryPeak(this.mqttPeak, payload.state);

      // 2. WebRTC P2P DataChannel (~40 FPS, або МИТТЄВО на кожен удар бочки!)
      if (this.webrtcChannel && this.webrtcChannel.readyState === "open") {
        const isBeat = this.p2pPeak[7] === 1;
        const elapsedP2P = now - this.lastTelemetrySentP2P;
        if (elapsedP2P >= 24 || (isBeat && elapsedP2P >= 12)) {
          this.lastTelemetrySentP2P = now;
          const p2pPacket = {
            type: "dspTelemetry",
            state: this.p2pPeak,
            sender: this.clientId,
            room: this.roomId,
            seq,
          };
          this.p2pPeak = null;
          try {
            this.webrtcChannel.send(JSON.stringify(p2pPacket));
          } catch {
            this.p2pConnected = false;
          }
        }
      }

      // 3. Локальний Wi-Fi сервер
      if (this.lanWs && this.lanWs.readyState === WebSocket.OPEN) {
        try {
          this.lanWs.send(JSON.stringify(basePacket));
        } catch {}
      }

      // 4. Хмарний MQTT Mesh (~20 FPS, або МИТТЄВО на удар бочки!)
      // Відправляємо завжди як надійний канал (навіть якщо відкрито P2P з іншою вкладкою)
      if (this.cloudConnected) {
        const isBeat = this.mqttPeak[7] === 1;
        const elapsedMqtt = now - this.lastTelemetrySentMqtt;
        if (elapsedMqtt >= 50 || (isBeat && elapsedMqtt >= 25)) {
          this.lastTelemetrySentMqtt = now;
          const mqttPacket = {
            type: "dspTelemetry",
            state: this.mqttPeak,
            sender: this.clientId,
            room: this.roomId,
            seq,
          };
          this.mqttPeak = null;
          this.publishToCloudBrokers(JSON.stringify(mqttPacket));
        }
      }
      return;
    }

    // Усі інші події (перемикання сцен, XY-пад, Filmora FX, Strobe, Shockwave, Heartbeat) відправляємо миттєво у всі канали
    const jsonStr = JSON.stringify(basePacket);

    if (this.webrtcChannel && this.webrtcChannel.readyState === "open") {
      try {
        this.webrtcChannel.send(jsonStr);
      } catch {
        this.p2pConnected = false;
      }
    }

    if (this.lanWs && this.lanWs.readyState === WebSocket.OPEN) {
      try {
        this.lanWs.send(jsonStr);
      } catch {}
    }

    if (this.cloudConnected) {
      this.publishToCloudBrokers(jsonStr);
    }
  }

  notifyStatus() {
    if (this.onMessage) {
      this.onMessage({
        type: "syncStatus",
        connected:
          this.cloudConnected ||
          (this.lanWs && this.lanWs.readyState === WebSocket.OPEN),
        connectedCount: this.connectedBrokerCount || 0,
        isLan: this.lanWs && this.lanWs.readyState === WebSocket.OPEN,
        p2p: this.p2pConnected,
        roomId: this.roomId,
      });
    }
  }
}

window.SyncManager = SyncManager;
