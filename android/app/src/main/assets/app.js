/**
 * Головний контролер AURA VJ PRO (Проектор + Смартфон Пульт + TouchDesigner & Filmora FX Studio)
 */
class AuraVJApp {
  constructor() {
    this.dsp = new DSPEngine();
    this.canvas = document.getElementById("shaderCanvas");
    this.overlayCanvas = document.getElementById("tdOverlayCanvas");
    this.visualizer = new ShaderVisualizer(this.canvas, this.overlayCanvas);
    this.sync = new SyncManager((msg) => this.handleSyncMessage(msg));

    this.currentView = "split"; // 'split' | 'projector' | 'remote'
    this.hudTimeout = null;
    this.audioStarted = false;
    this.cameraStream = null;
    this.wakeLock = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.userPresets = this.loadUserPresets();

    // Комерційна модель: 4 сцени у FREE, 5 преміум-сцен у PRO
    this.proScenes = ["blobtrack", "pointcloud", "reaction", "ferrofluid", "fractal"];
    this.isPro = this.loadProStatus();
    this.visualizer.isPro = this.isPro;
    this.visualizer.roomId = this.sync.roomId;

    this.projectorHudCollapsed = false;
    try {
      this.projectorHudCollapsed =
        localStorage.getItem("aura_projector_hud_collapsed") === "true";
    } catch {}

    this.initUrlParams();
    this.setupUI();
    this.setupProLicensing();
    this.setupVideoRecorder();
    this.setupVenueAndKeystone();
    this.setupStudioTabs();
    this.setupMonitorToggle();
    this.setupFilmoraFX();
    this.setupTouchDesignerCHOP();
    this.setupMediaTop();
    this.setupXYPad();
    this.setupFXButtons();
    this.loadSavedCustomEffects();
    this.setupSpatialNavigation();
    this.setupAutoHideHud();
    this.setupDesktopShortcuts();
    this.setupDesktopMouseInteractions();
    this.setupProjectorHudControls();
    this.setupPeerSyncHeartbeat();
    this.setupScreenKeepAlive();

    // Кешуємо посилання на DOM елементи для усунення 600+ DOM-пошуків за секунду в loop()
    this.meterEls = {
      sub: document.getElementById("meterSub"),
      bass: document.getElementById("meterBass"),
      mid: document.getElementById("meterMid"),
      high: document.getElementById("meterHigh"),
    };
    this.beatLedEl = document.getElementById("beatLed");
    this.bpmDisplayEl = document.getElementById("bpmDisplay");
    this.micLiveDotEl = document.getElementById("micLiveDot");
    this.chopBarEls = {};
    ["rgbSplit", "glitch", "kaleido", "edges", "feedback", "pixelate"].forEach((k) => {
      this.chopBarEls[k] = document.getElementById(`chopBar_${k}`);
    });

    window.onAndroidBackPressed = () => {
      const qrModal = document.getElementById("qrModal");
      if (qrModal && !qrModal.hidden) {
        qrModal.hidden = true;
        return true;
      }
      const shortcutsModal = document.getElementById("shortcutsModal");
      if (shortcutsModal && !shortcutsModal.hidden) {
        shortcutsModal.hidden = true;
        return true;
      }
      const proModal = document.getElementById("proModal");
      if (proModal && !proModal.hidden) {
        proModal.hidden = true;
        return true;
      }
      if (this.projectorHudCollapsed) {
        this.setProjectorHudCollapsed(false, true);
        return true;
      }
      return false;
    };

    // Запускаємо рендер-цикл одразу (навіть до першого кліку працює візуальне демо)
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  loadProStatus() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("pro") === "1") {
      try {
        localStorage.setItem("aura_vj_pro_active", "true");
      } catch {}
      return true;
    }
    try {
      return localStorage.getItem("aura_vj_pro_active") === "true";
    } catch {
      return false;
    }
  }

  setProStatus(active, broadcast = true) {
    this.isPro = !!active;
    this.visualizer.isPro = this.isPro;
    try {
      localStorage.setItem("aura_vj_pro_active", this.isPro ? "true" : "false");
    } catch {}
    this.updateProUI();
    if (broadcast) {
      this.sync.send({ type: "proStatus", isPro: this.isPro });
    }
  }

  updateProUI() {
    const badge = document.getElementById("btnProBadge");
    const badgeText = document.getElementById("proBadgeText");
    const demoBtn = document.getElementById("btnInstantProDemo");
    const desc = document.getElementById("proModalStatusDesc");

    if (badge) badge.classList.toggle("is-pro", this.isPro);
    if (badgeText) badgeText.textContent = this.isPro ? "💎 PRO" : "FREE";

    document.querySelectorAll(".vj-pad[data-mode]").forEach((pad) => {
      const mode = pad.dataset.mode;
      const locked = !this.isPro && this.proScenes.includes(mode);
      pad.classList.toggle("pro-locked", locked);
    });

    if (demoBtn) {
      demoBtn.textContent = this.isPro
        ? "🔄 Перемкнути назад у FREE Режим (для тесту)"
        : "⚡ Увімкнути PRO Режим (Тестова Активація в 1 клік)";
    }
    if (desc) {
      desc.textContent = this.isPro
        ? "✅ Ліцензія AURA VJ PRO активна! Всі 9 сцен, B2B-вивіска, Keystone-маска та FX Lab розблоковані."
        : "Розблокуйте всі 9 TouchDesigner сцен, 6-шаровий Filmora FX стек, B2B-вивіску для закладів, Keystone-маску та приберіть водяний знак.";
    }
  }

  setupScreenKeepAlive() {
    this.keepAliveVideo = null;

    const enableKeepAlive = async () => {
      // 1. Native Screen WakeLock API
      if ("wakeLock" in navigator) {
        try {
          this.wakeLock = await navigator.wakeLock.request("screen");
        } catch {}
      }

      // 2. Безперервний фоновий 1x1 беззвучний цикл відео для iOS Safari / Chrome Mobile (NoSleep патерн)
      // На iPhone / Android це запобігає засинанню екрана та скиданню фокусу мікрофона
      if (!this.keepAliveVideo) {
        try {
          const video = document.createElement("video");
          video.setAttribute("playsinline", "");
          video.setAttribute("webkit-playsinline", "");
          video.setAttribute("muted", "");
          video.muted = true;
          video.loop = true;
          video.width = 1;
          video.height = 1;
          video.style.position = "fixed";
          video.style.left = "-100px";
          video.style.top = "-100px";
          video.style.opacity = "0.001";
          video.style.pointerEvents = "none";
          video.src =
            "data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQAAAAhmcmVlAAAACG1kYXQAAAAIZmRzYwAAAAFtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAKAABAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
          document.body.appendChild(video);
          this.keepAliveVideo = video;
          const playPromise = video.play();
          if (playPromise) playPromise.catch(() => {});
        } catch {}
      } else if (this.keepAliveVideo.paused) {
        try {
          this.keepAliveVideo.play().catch(() => {});
        } catch {}
      }
    };

    this.enableKeepAlive = enableKeepAlive;

    // Активуємо при першому та наступних дотиках/кліках
    window.addEventListener("pointerdown", enableKeepAlive, { passive: true });
    window.addEventListener("touchstart", enableKeepAlive, { passive: true });
    window.addEventListener("click", enableKeepAlive, { passive: true });

    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        enableKeepAlive();
      }
    });

    enableKeepAlive();
  }

  initUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    if (view && ["split", "projector", "remote"].includes(view)) {
      this.setView(view);
      if (view === "remote") {
        this.dsp.activeSource = "mic";
        this.highlightSourceButton("mic");
      }
    } else if (window.AndroidAudioBridge) {
      // Якщо запущено всередині Android APK на проекторі — одразу вмикаємо режим Проектора
      this.setView("projector");
    }

    // Глобальний хук для прийому системного звуку Android Visualizer(0) (YouTube Music / Cast)
    window.onAndroidNativeFFT = (binsArray) => {
      if (this.dsp.activeSource !== "native_android") {
        this.dsp.activeSource = "native_android";
        this.dsp.isRunning = true;
        this.audioStarted = true;
        this.highlightSourceButton("native_android");
      }
      this.dsp.ingestNativeAndroidBins(binsArray);
    };

    // Автоматичний fallback, якщо Android 12+ DRM блокує Visualizer(0)
    window.onAndroidAudioFallback = (reason) => {
      console.warn("Android Visualizer(0) fallback:", reason);
      if (this.dsp.activeSource === "native_android") {
        this.ensureAudioStarted("mic");
        this.highlightSourceButton("mic");
      }
    };
  }

  setView(viewName) {
    this.currentView = viewName;
    document.body.dataset.view = viewName;
    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.targetView === viewName);
    });
    if (viewName === "projector") {
      document.body.classList.toggle("projector-hud-collapsed", !!this.projectorHudCollapsed);
      this.resetHudTimer();
    } else if (viewName === "remote") {
      document.body.classList.remove("projector-hud-collapsed");
      if (!this.audioStarted) {
        this.dsp.activeSource = "mic";
        this.highlightSourceButton("mic");
      }
    } else {
      document.body.classList.toggle("projector-hud-collapsed", !!this.projectorHudCollapsed);
    }
    this.updateProjectorHudUI();
  }

  async ensureAudioStarted(source = "synth", file = null) {
    try {
      const res = await this.dsp.start(source, file);
      if (res && res.aborted) return;
      this.audioStarted = true;
      const actualSource = (res && res.source) || source;
      this.highlightSourceButton(actualSource === "screen" ? "native_android" : actualSource);
      const banner = document.getElementById("micStartBanner");
      if (banner && (actualSource === "mic" || this.currentView === "remote")) {
        banner.classList.add("active");
        const btn = document.getElementById("btnStartRemoteMic");
        if (btn && actualSource === "mic") {
          btn.textContent = "ТРАНСЛЮЄТЬСЯ 🟢";
        }
      }
    } catch (err) {
      if (err && err.isHttpsRequired && err.targetUrl) {
        if (
          confirm(
            "Для доступу до мікрофона на iPhone / Android потрібне захищене з'єднання (HTTPS).\n\nПерейти на HTTPS (порт 3457) прямо зараз?"
          )
        ) {
          window.location.href = err.targetUrl;
          return;
        }
      }
      alert(`Увага: ${err.message}. Перемикаємо на вбудований Техно-Синтезатор.`);
      const res = await this.dsp.start("synth");
      if (res && res.aborted) return;
      this.audioStarted = true;
      this.highlightSourceButton("synth");
    }
  }

  setupUI() {
    const roomTextEl = document.getElementById("roomCodeText");
    if (roomTextEl) roomTextEl.textContent = this.sync.roomId;

    if (window.AndroidAudioBridge) {
      if (typeof window.AndroidAudioBridge.getProjectorIp === "function") {
        const projIp = window.AndroidAudioBridge.getProjectorIp();
        if (projIp && projIp !== "127.0.0.1") {
          this.sync.setServerHost(`${projIp}:3456`);
        }
      }
      this.ensureAudioStarted("native_android");
    }

    const unlockAudio = (e) => {
      const target = e?.target;
      // Ігноруємо кліки по кнопках джерел звуку, перемикачах режимів та модалках, щоб уникнути подвійного виклику start()
      if (
        target instanceof Element &&
        target.closest(
          ".src-pill, #micStartBanner, #btnStartRemoteMic, .view-btn, #btnQrModal, #btnRoomBadge, #btnFullscreen, #qrModal, #proModal, #shortcutsModal"
        )
      ) {
        return;
      }
      // На екрані Проектора або при активному прийомі телеметрії з Пульта НЕ запускаємо локальний синтезатор!
      if (this.currentView === "projector" || this.dsp.activeSource === "remote") {
        return;
      }
      if (!this.audioStarted) {
        this.ensureAudioStarted(this.dsp.activeSource);
      }
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);

    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.setView(btn.dataset.targetView));
    });

    const fileInput = document.getElementById("audioFileInput");
    document.querySelectorAll(".src-pill").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const src = btn.dataset.source;
        if (src === "file") {
          fileInput.click();
          return;
        }
        this.highlightSourceButton(src);
        await this.ensureAudioStarted(src);
      });
    });

    // Підсилювач чутливості мікрофона (Boost 1x -> 2.5x -> 4.5x)
    const btnBoost = document.getElementById("btnMicBoost");
    const txtBoost = document.getElementById("txtMicBoost");
    const boostLevels = [1.0, 2.5, 4.5];
    let boostIdx = 1;
    if (btnBoost) {
      btnBoost.addEventListener("click", () => {
        boostIdx = (boostIdx + 1) % boostLevels.length;
        const val = boostLevels[boostIdx];
        this.dsp.setMicGain(val);
        if (txtBoost) txtBoost.textContent = `BOOST ${val}X`;
      });
    }

    // Банер швидкого увімкнення мікрофона на пульті смартфона (без подвійного спрацювання)
    const micBanner = document.getElementById("micStartBanner");
    const btnStartRemoteMic = document.getElementById("btnStartRemoteMic");

    if (micBanner) {
      if (!window.isSecureContext && location.protocol === "http:") {
        const bannerText = micBanner.querySelector(".mic-start-texts span");
        if (bannerText) {
          bannerText.textContent = "Натисніть для переходу на HTTPS (порт 3457) для роботи мікрофона";
        }
        if (btnStartRemoteMic) {
          btnStartRemoteMic.textContent = "HTTPS 3457 🔒";
        }
      }

      const activateMicHandler = async (e) => {
        if (e) e.stopPropagation();
        if (!window.isSecureContext && location.protocol === "http:") {
          window.location.href = `https://${location.hostname}:3457${location.pathname}${location.search}`;
          return;
        }
        this.highlightSourceButton("mic");
        await this.ensureAudioStarted("mic");
        if (micBanner) micBanner.classList.add("active");
        if (btnStartRemoteMic) btnStartRemoteMic.textContent = "ТРАНСЛЮЄТЬСЯ 🟢";
      };

      micBanner.addEventListener("click", activateMicHandler);
      if (btnStartRemoteMic) btnStartRemoteMic.addEventListener("click", activateMicHandler);
    }

    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (file) {
        this.highlightSourceButton("file");
        await this.ensureAudioStarted("file", file);
      }
    });

    const chkSynth = document.getElementById("chkSynthAudio");
    chkSynth.addEventListener("change", (e) => {
      this.dsp.setSynthMute(!e.target.checked);
    });

    const selectMode = (mode) => {
      if (!this.isPro && this.proScenes.includes(mode)) {
        const proModal = document.getElementById("proModal");
        if (proModal) proModal.hidden = false;
        return;
      }
      this.visualizer.setMode(mode);
      this.highlightModeButtons(mode);
      this.sync.send({ type: "mode", mode });
    };
    this.selectMode = selectMode;

    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => selectMode(btn.dataset.mode));
    });

    const qrModal = document.getElementById("qrModal");
    const openQrModal = () => {
      this.renderQrModal();
      qrModal.hidden = false;
    };
    document.getElementById("btnQrModal").addEventListener("click", openQrModal);
    const btnRoomBadge = document.getElementById("btnRoomBadge");
    if (btnRoomBadge) {
      btnRoomBadge.addEventListener("click", openQrModal);
    }
    document.getElementById("btnCloseQr").addEventListener("click", () => {
      qrModal.hidden = true;
    });
    const btnUpdateApk = document.getElementById("btnUpdateApkNative");
    if (btnUpdateApk && window.AndroidAudioBridge && typeof window.AndroidAudioBridge.updateApk === "function") {
      btnUpdateApk.style.display = "block";
      btnUpdateApk.addEventListener("click", () => {
        window.AndroidAudioBridge.updateApk();
      });
    }
    const btnJoinRoom = document.getElementById("btnJoinRoom");
    const roomInput = document.getElementById("roomInput");
    const submitJoin = () => {
      const val = roomInput ? roomInput.value.trim() : "";
      if (val) {
        this.sync.setRoomId(val);
        this.visualizer.roomId = this.sync.roomId;
        this.renderQrModal();
        this.sync.send({ type: "peerHeartbeat", role: this.currentView });
        if (btnJoinRoom) btnJoinRoom.textContent = "CONNECTED!";
        setTimeout(() => {
          if (btnJoinRoom) btnJoinRoom.textContent = "CONNECT";
          qrModal.hidden = true;
        }, 500);
      }
    };
    if (btnJoinRoom) {
      btnJoinRoom.addEventListener("click", submitJoin);
    }
    if (roomInput) {
      roomInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitJoin();
        }
      });
    }

    document.getElementById("btnFullscreen").addEventListener("click", () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  /**
   * Комерційна система ліцензування AURA VJ PRO
   */
  setupProLicensing() {
    this.updateProUI();
    const proModal = document.getElementById("proModal");
    const btnProBadge = document.getElementById("btnProBadge");
    const btnClosePro = document.getElementById("btnCloseProModal");
    const btnActivateKey = document.getElementById("btnActivateKey");
    const btnInstantPro = document.getElementById("btnInstantProDemo");
    const keyInput = document.getElementById("proLicenseInput");

    if (btnProBadge && proModal) {
      btnProBadge.addEventListener("click", () => {
        proModal.hidden = false;
      });
    }
    if (btnClosePro && proModal) {
      btnClosePro.addEventListener("click", () => {
        proModal.hidden = true;
      });
    }
    if (btnInstantPro) {
      btnInstantPro.addEventListener("click", () => {
        this.setProStatus(!this.isPro, true);
      });
    }
    if (btnActivateKey && keyInput) {
      btnActivateKey.addEventListener("click", () => {
        const val = keyInput.value.trim().toUpperCase();
        if (val.startsWith("AURA-") || val.startsWith("VIP-") || val.length >= 6) {
          this.setProStatus(true, true);
          keyInput.value = "";
          if (proModal) proModal.hidden = true;
        } else {
          alert("Введіть дійсний ключ (наприклад, AURA-PRO-2026) або натисніть кнопку тестової активації нижче.");
        }
      });
    }
    document.querySelectorAll(".pro-plan-card").forEach((card) => {
      card.addEventListener("click", () => {
        if (keyInput) keyInput.value = "AURA-PRO-2026";
        this.setProStatus(true, true);
      });
    });
  }

  /**
   * Вбудований 60 FPS відео-рекордер (WebGL + Audio) для TikTok / Instagram Reels
   */
  setupVideoRecorder() {
    const btnRec = document.getElementById("btnRecordVideo");
    const recText = document.getElementById("recBtnText");
    if (!btnRec || !this.canvas) return;

    btnRec.addEventListener("click", () => {
      if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
        this.mediaRecorder.stop();
        return;
      }

      try {
        const canvasStream = this.canvas.captureStream(60);
        const tracks = [...canvasStream.getVideoTracks()];

        if (this.dsp && this.dsp.ctx && this.dsp.masterGain) {
          try {
            const dest = this.dsp.ctx.createMediaStreamDestination();
            this.dsp.masterGain.connect(dest);
            tracks.push(...dest.stream.getAudioTracks());
          } catch {}
        }

        const combinedStream = new MediaStream(tracks);
        const mimeTypes = [
          "video/mp4;codecs=avc1",
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ];
        const mimeType = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || "";

        this.recordedChunks = [];
        this.mediaRecorder = mimeType
          ? new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 8000000 })
          : new MediaRecorder(combinedStream);

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
        };

        this.mediaRecorder.onstop = () => {
          btnRec.classList.remove("recording");
          if (recText) recText.textContent = "REC";
          const blob = new Blob(this.recordedChunks, {
            type: this.mediaRecorder.mimeType || "video/webm",
          });
          const ext = (this.mediaRecorder.mimeType || "").includes("mp4") ? "mp4" : "webm";
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `aura-vj-reel-${Date.now()}.${ext}`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        };

        this.mediaRecorder.start(200);
        btnRec.classList.add("recording");
        if (recText) recText.textContent = "STOP";
      } catch (err) {
        alert(`Запис відео не підтримується у цьому браузері: ${err.message}`);
      }
    });
  }

  /**
   * B2B Вивіска для барів/івентів + Keystone-маска стіни проектора
   */
  setupVenueAndKeystone() {
    const chkVenue = document.getElementById("chkVenueOverlay");
    const inputTitle = document.getElementById("inputVenueTitle");
    const inputSub = document.getElementById("inputVenueSub");
    const rangeScale = document.getElementById("rangeKeystoneScale");
    const valScale = document.getElementById("val_keystoneScale");
    const rangeCrop = document.getElementById("rangeKeystoneCrop");
    const valCrop = document.getElementById("val_keystoneCrop");

    const syncVenueAndKeystone = () => {
      if (!this.isPro && chkVenue && chkVenue.checked) {
        chkVenue.checked = false;
        const proModal = document.getElementById("proModal");
        if (proModal) proModal.hidden = false;
        return;
      }
      this.visualizer.venueOverlay = {
        enabled: chkVenue ? chkVenue.checked : false,
        title: inputTitle ? inputTitle.value.trim() : "",
        subtitle: inputSub ? inputSub.value.trim() : "",
      };
      this.visualizer.keystone = {
        scale: rangeScale ? Number(rangeScale.value) / 100 : 1.0,
        cropX: rangeCrop ? Number(rangeCrop.value) / 100 : 0.0,
        cropY: rangeCrop ? Number(rangeCrop.value) / 100 : 0.0,
      };
      if (valScale && rangeScale) valScale.textContent = `${rangeScale.value}%`;
      if (valCrop && rangeCrop) valCrop.textContent = `${rangeCrop.value}%`;

      this.sync.send({
        type: "venueKeystone",
        venueOverlay: this.visualizer.venueOverlay,
        keystone: this.visualizer.keystone,
      });
    };

    [chkVenue, inputTitle, inputSub, rangeScale, rangeCrop].forEach((el) => {
      if (!el) return;
      el.addEventListener("input", syncVenueAndKeystone);
      el.addEventListener("change", syncVenueAndKeystone);
    });
  }

  /**
   * Вкладки студії: Сцени & XY / Filmora FX / TouchDesigner CHOP Ноди / Відео & Камера / Консоль (Все)
   */
  setupStudioTabs() {
    const deck = document.getElementById("mobileDeck");
    const tabs = document.querySelectorAll(".studio-tab");
    const panels = document.querySelectorAll(".studio-panel");

    const activateTab = (targetId) => {
      tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === targetId));
      if (targetId === "tabAll") {
        if (deck) deck.classList.add("console-all-active");
        panels.forEach((p) => p.classList.add("active"));
      } else {
        if (deck) deck.classList.remove("console-all-active");
        panels.forEach((p) => p.classList.toggle("active", p.id === targetId));
      }
    };

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        activateTab(tab.dataset.tab);
      });
    });

    // На десктопі (>= 1024px) за замовчуванням активуємо повноцінний VJ-пульт "Консоль (Все)"
    if (window.innerWidth >= 1024) {
      activateTab("tabAll");
    }

    let lastWidth = window.innerWidth;
    window.addEventListener("resize", () => {
      const isDesktopNow = window.innerWidth >= 1024;
      const wasDesktop = lastWidth >= 1024;
      if (isDesktopNow !== wasDesktop) {
        lastWidth = window.innerWidth;
        if (isDesktopNow) {
          activateTab("tabAll");
        } else {
          activateTab("tabScenes");
        }
      }
    });
  }

  /**
   * Перемикання Live Program Monitor на пульті (сховати/показати)
   */
  toggleProgramMonitor() {
    const stage = document.getElementById("projectorStage");
    const btn = document.getElementById("btnToggleMonitor");
    if (!stage) return;
    stage.classList.toggle("monitor-hidden");
    const isHidden = stage.classList.contains("monitor-hidden");
    if (btn) {
      btn.classList.toggle("active", !isHidden);
      const txt = btn.querySelector("#monitorBtnText");
      if (txt) txt.textContent = isHidden ? "MONITOR OFF" : "MONITOR";
    }
    setTimeout(() => this.visualizer?.onResize(), 60);
  }

  /**
   * Керування кнопкою Live Program Monitor у верхній панелі
   */
  setupMonitorToggle() {
    const btn = document.getElementById("btnToggleMonitor");
    if (btn) {
      btn.addEventListener("click", () => this.toggleProgramMonitor());
    }
  }

  /**
   * Конструктор шарів Filmora FX + Пресети комбінацій + TouchDesigner CV Blob HUD
   */
  setupFilmoraFX() {
    const chkBlobHud = document.getElementById("chkBlobHud");
    if (chkBlobHud) {
      chkBlobHud.addEventListener("change", (e) => {
        this.visualizer.blobHudEnabled = e.target.checked;
        this.broadcastPostFxState();
      });
    }

    document.querySelectorAll(".fx-range").forEach((slider) => {
      slider.addEventListener("input", (e) => {
        const name = slider.dataset.fx;
        const pct = Number(e.target.value);
        this.visualizer.setPostFx(name, pct / 100);
        const label = document.getElementById(`val_${name}`);
        if (label) label.textContent = `${pct}%`;
        this.broadcastPostFxState();
      });
    });

    const builtInPresets = {
      clean: {
        postFx: { rgbSplit: 0, glitch: 0, kaleido: 0, edges: 0, feedback: 0, pixelate: 0 },
        blobHud: false,
      },
      vhs: {
        postFx: { rgbSplit: 0.65, glitch: 0.58, kaleido: 0, edges: 0, feedback: 0.2, pixelate: 0 },
        blobHud: false,
      },
      td_cv: {
        postFx: { rgbSplit: 0.3, glitch: 0.15, kaleido: 0, edges: 0.65, feedback: 0.35, pixelate: 0 },
        blobHud: true,
      },
      acid: {
        postFx: { rgbSplit: 0.45, glitch: 0, kaleido: 0.65, edges: 0.25, feedback: 0.72, pixelate: 0 },
        blobHud: false,
      },
      led: {
        postFx: { rgbSplit: 0.25, glitch: 0.2, kaleido: 0, edges: 0, feedback: 0, pixelate: 0.68 },
        blobHud: false,
      },
    };

    document.querySelectorAll("[data-fx-preset]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const key = chip.dataset.fxPreset;
        const preset = builtInPresets[key];
        if (!preset) return;
        document.querySelectorAll("[data-fx-preset]").forEach((c) =>
          c.classList.toggle("active", c === chip)
        );
        this.applyPatchState({
          postFx: preset.postFx,
          blobHudEnabled: preset.blobHud,
        });
        this.broadcastPostFxState();
      });
    });
  }

  /**
   * TouchDesigner Audio-CHOP Матриця маршрутизації + Генератор патчів + Збереження пресетів
   */
  setupTouchDesignerCHOP() {
    document.querySelectorAll(".chop-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const name = sel.dataset.chop;
        this.visualizer.setChopRoute(name, e.target.value);
        this.broadcastPostFxState();
      });
    });

    const btnRandom = document.getElementById("btnRandomPatch");
    if (btnRandom) {
      btnRandom.addEventListener("click", () => {
        const sources = ["none", "subBass", "bass", "mid", "high", "lfo"];
        const randomPostFx = {};
        const randomChop = {};
        Object.keys(this.visualizer.postFx).forEach((key) => {
          const active = Math.random() > 0.42;
          randomPostFx[key] = active ? Number((0.2 + Math.random() * 0.65).toFixed(2)) : 0;
          randomChop[key] = active
            ? sources[Math.floor(Math.random() * sources.length)]
            : "none";
        });
        this.applyPatchState({
          postFx: randomPostFx,
          chopRouting: randomChop,
          blobHudEnabled: Math.random() > 0.5,
        });
        this.broadcastPostFxState();
      });
    }

    const btnSave = document.getElementById("btnSaveUserPreset");
    if (btnSave) {
      btnSave.addEventListener("click", () => {
        const name = prompt(
          "Назва вашого пресету (TouchDesigner / Filmora):",
          `Мій Патч #${this.userPresets.length + 1}`
        );
        if (!name) return;
        const entry = {
          name: name.trim().slice(0, 22),
          mode: this.visualizer.modes[this.visualizer.modeIndex],
          postFx: { ...this.visualizer.postFx },
          chopRouting: { ...this.visualizer.chopRouting },
          blobHudEnabled: this.visualizer.blobHudEnabled,
        };
        this.userPresets.push(entry);
        this.saveUserPresets();
        this.renderUserPresets();
      });
    }

    this.renderUserPresets();
  }

  loadUserPresets() {
    try {
      const raw = localStorage.getItem("aura_vj_user_presets");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  saveUserPresets() {
    try {
      localStorage.setItem("aura_vj_user_presets", JSON.stringify(this.userPresets));
    } catch {
      // Ігноруємо помилки quota
    }
  }

  renderUserPresets() {
    const bar = document.getElementById("userPresetsBar");
    if (!bar) return;
    bar.innerHTML = "";
    this.userPresets.forEach((preset, idx) => {
      const btn = document.createElement("button");
      btn.className = "fx-chip";
      btn.textContent = `[USR] ${preset.name}`;
      btn.addEventListener("click", () => {
        if (preset.mode) {
          this.visualizer.setMode(preset.mode);
          this.highlightModeButtons(preset.mode);
          this.sync.send({ type: "mode", mode: preset.mode });
        }
        this.applyPatchState(preset);
        this.broadcastPostFxState();
      });
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.userPresets.splice(idx, 1);
        this.saveUserPresets();
        this.renderUserPresets();
      });
      bar.appendChild(btn);
    });
  }

  applyPatchState(state) {
    if (state.postFx) {
      Object.entries(state.postFx).forEach(([k, val]) => {
        this.visualizer.setPostFx(k, val);
        const slider = document.querySelector(`.fx-range[data-fx="${k}"]`);
        const label = document.getElementById(`val_${k}`);
        const pct = Math.round(val * 100);
        if (slider) slider.value = String(pct);
        if (label) label.textContent = `${pct}%`;
      });
    }
    if (state.chopRouting) {
      Object.entries(state.chopRouting).forEach(([k, src]) => {
        this.visualizer.setChopRoute(k, src);
        const sel = document.querySelector(`.chop-select[data-chop="${k}"]`);
        if (sel) sel.value = src;
      });
    }
    if (typeof state.blobHudEnabled === "boolean") {
      this.visualizer.blobHudEnabled = state.blobHudEnabled;
      const chk = document.getElementById("chkBlobHud");
      if (chk) chk.checked = state.blobHudEnabled;
    }
  }

  broadcastPostFxState() {
    this.sync.send({
      type: "postFx",
      postFx: this.visualizer.postFx,
      chopRouting: this.visualizer.chopRouting,
      blobHudEnabled: this.visualizer.blobHudEnabled,
    });
  }

  /**
   * Media TOP: Завантаження власного Відео / Фото або підключення Живої Камери під шейдери
   */
  setupMediaTop() {
    const btnUpload = document.getElementById("btnUploadMedia");
    const btnCamera = document.getElementById("btnLiveCamera");
    const btnClear = document.getElementById("btnClearMedia");
    const mediaInput = document.getElementById("mediaFileInput");
    const videoEl = document.getElementById("customVideoEl");
    const imgEl = document.getElementById("customImageEl");
    const rangeMix = document.getElementById("rangeMediaMix");
    const valMix = document.getElementById("val_mediaMix");

    const updateMixUI = (pct, broadcast = true) => {
      this.visualizer.mediaMix = pct / 100;
      if (rangeMix) rangeMix.value = String(pct);
      if (valMix) valMix.textContent = `${pct}%`;
      if (broadcast) {
        this.sync.send({
          type: "mediaConfig",
          mix: this.visualizer.mediaMix,
          mode: this.visualizer.mediaBlendMode,
        });
      }
    };

    if (btnUpload && mediaInput) {
      btnUpload.addEventListener("click", () => mediaInput.click());
      mediaInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        this.stopCameraStream();

        if (file.type.startsWith("video/")) {
          const url = URL.createObjectURL(file);
          videoEl.srcObject = null;
          videoEl.src = url;
          videoEl.play().catch(() => {});
          this.visualizer.setMediaSource(videoEl);
          btnUpload.classList.add("active");
          if (btnCamera) btnCamera.classList.remove("active");
          updateMixUI(80);
        } else {
          // Читаємо та стискаємо фотографію для надшвидкої передачі на проектор по LAN
          const reader = new FileReader();
          reader.onload = (re) => {
            const rawData = re.target.result;
            const tempImg = new Image();
            tempImg.onload = () => {
              const maxDim = 1280;
              let w = tempImg.naturalWidth || tempImg.width;
              let h = tempImg.naturalHeight || tempImg.height;
              if (w > maxDim || h > maxDim) {
                if (w > h) {
                  h = Math.round((h * maxDim) / w);
                  w = maxDim;
                } else {
                  w = Math.round((w * maxDim) / h);
                  h = maxDim;
                }
              }
              const canvas = document.createElement("canvas");
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(tempImg, 0, 0, w, h);
              const dataUrl = canvas.toDataURL("image/jpeg", 0.82);

              imgEl.onload = () => {
                this.visualizer.setMediaSource(imgEl);
              };
              imgEl.src = dataUrl;

              // Транслюємо фото на проектор та інші пристрої в кімнаті через LAN WebSocket
              this.sync.send({
                type: "mediaImage",
                dataUrl: dataUrl,
                mix: 0.8,
                mode: this.visualizer.mediaBlendMode,
              });

              btnUpload.classList.add("active");
              if (btnCamera) btnCamera.classList.remove("active");
              updateMixUI(80);
            };
            tempImg.src = rawData;
          };
          reader.readAsDataURL(file);
        }
      });
    }

    if (btnCamera) {
      btnCamera.addEventListener("click", async () => {
        try {
          this.stopCameraStream();
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          this.cameraStream = stream;
          videoEl.src = "";
          videoEl.srcObject = stream;
          await videoEl.play();
          this.visualizer.setMediaSource(videoEl);
          btnCamera.classList.add("active");
          if (btnUpload) btnUpload.classList.remove("active");
          updateMixUI(85);
        } catch (err) {
          alert(`Не вдалося увімкнути камеру: ${err.message}`);
        }
      });
    }

    if (btnClear) {
      btnClear.addEventListener("click", () => {
        this.stopCameraStream();
        videoEl.pause();
        videoEl.src = "";
        imgEl.src = "";
        this.visualizer.clearMediaSource();
        if (btnUpload) btnUpload.classList.remove("active");
        if (btnCamera) btnCamera.classList.remove("active");
        updateMixUI(0);
        this.sync.send({ type: "mediaClear" });
      });
    }

    if (rangeMix) {
      rangeMix.addEventListener("input", (e) => {
        updateMixUI(Number(e.target.value));
      });
    }

    document.querySelectorAll("[data-media-mode]").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll("[data-media-mode]").forEach((c) =>
          c.classList.toggle("active", c === chip)
        );
        this.visualizer.mediaBlendMode = Number(chip.dataset.mediaMode) || 0;
        this.sync.send({
          type: "mediaConfig",
          mix: this.visualizer.mediaMix,
          mode: this.visualizer.mediaBlendMode,
        });
      });
    });
  }

  stopCameraStream() {
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach((t) => t.stop());
      this.cameraStream = null;
    }
  }

  highlightSourceButton(source) {
    document.querySelectorAll(".src-pill").forEach((b) => {
      const isMatch = b.dataset.source === source;
      b.classList.toggle("active", isMatch);
      b.setAttribute("tabindex", isMatch ? "0" : "-1");
    });
  }

  highlightModeButtons(mode) {
    document.querySelectorAll("[data-mode]").forEach((b) => {
      const isMatch = b.dataset.mode === mode;
      b.classList.toggle("active", isMatch);
      b.setAttribute("tabindex", isMatch ? "0" : "-1");
    });
  }

  setupXYPad() {
    const pad = document.getElementById("xyPad");
    if (!pad) return;
    let isDragging = false;

    const updateFromEvent = (e) => {
      const rect = pad.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const y = Math.max(0, Math.min(1, 1.0 - (clientY - rect.top) / Math.max(1, rect.height)));
      this.updateXYUI(x, y);
      this.visualizer.setXY(x, y);
      this.sync.send({ type: "xy", x, y });
    };

    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      isDragging = true;
      try {
        pad.setPointerCapture(e.pointerId);
      } catch {}
      updateFromEvent(e);
      if (navigator.vibrate) navigator.vibrate(10);
    });

    pad.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      e.preventDefault();
      updateFromEvent(e);
    });

    const stopDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      if (e && typeof e.pointerId === "number") {
        try {
          pad.releasePointerCapture(e.pointerId);
        } catch {}
      }
    };
    pad.addEventListener("pointerup", stopDrag);
    pad.addEventListener("pointercancel", stopDrag);

    // Блокуємо скрол екрана телефону при русі пальцем по тачпаду
    pad.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    pad.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }

  updateXYUI(x, y) {
    const puck = document.getElementById("xyPuck");
    if (puck) {
      puck.style.left = `${x * 100}%`;
      puck.style.top = `${(1 - y) * 100}%`;
    }
    const coordsBadge = document.getElementById("xyCoordsBadge");
    if (coordsBadge) {
      coordsBadge.textContent = `X: ${Math.round(x * 100)}% · Y: ${Math.round(y * 100)}%`;
    }
  }

  setupFXButtons() {
    const btnStrobe = document.getElementById("fxStrobe");
    const btnShockwave = document.getElementById("fxShockwave");
    const btnFreeze = document.getElementById("fxFreeze");
    const btnColorDrop = document.getElementById("fxColorDrop");

    const vibrate = (ms = 15) => {
      if (navigator.vibrate) {
        try { navigator.vibrate(ms); } catch {}
      }
    };

    // Блокуємо виділення тексту та системне меню iOS Safari при утриманні тактильних клавіш
    document.addEventListener("selectstart", (e) => {
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
      }
    });

    [btnStrobe, btnShockwave, btnFreeze, btnColorDrop].forEach((btn) => {
      if (!btn) return;
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
      btn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    });

    const setStrobe = (active) => {
      this.visualizer.fx.strobe = active;
      if (btnStrobe) btnStrobe.classList.toggle("active", active);
      this.sync.send({ type: "fx", effect: "strobe", active });
    };
    if (btnStrobe) {
      btnStrobe.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        vibrate(25);
        try {
          btnStrobe.setPointerCapture(e.pointerId);
        } catch {}
        setStrobe(true);
      });
      btnStrobe.addEventListener("pointerup", () => setStrobe(false));
      btnStrobe.addEventListener("pointerleave", () => setStrobe(false));
      btnStrobe.addEventListener("pointercancel", () => setStrobe(false));
      btnStrobe.addEventListener("touchend", () => setStrobe(false));
      btnStrobe.addEventListener("touchcancel", () => setStrobe(false));
    }

    const setFreeze = (active) => {
      this.visualizer.fx.freeze = active;
      if (btnFreeze) btnFreeze.classList.toggle("active", active);
      this.sync.send({ type: "fx", effect: "freeze", active });
    };
    if (btnFreeze) {
      btnFreeze.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        vibrate(18);
        try {
          btnFreeze.setPointerCapture(e.pointerId);
        } catch {}
        setFreeze(!this.visualizer.fx.freeze);
      });
    }

    if (btnShockwave) {
      btnShockwave.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        vibrate(22);
        this.visualizer.triggerShockwave();
        btnShockwave.classList.add("active");
        setTimeout(() => btnShockwave.classList.remove("active"), 140);
        this.sync.send({ type: "fx", effect: "shockwave" });
      });
    }

    if (btnColorDrop) {
      btnColorDrop.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        vibrate(18);
        this.visualizer.triggerColorDrop();
        btnColorDrop.classList.add("active");
        setTimeout(() => btnColorDrop.classList.remove("active"), 140);
        this.sync.send({
          type: "fx",
          effect: "colordrop",
          colorShift: this.visualizer.colorShift,
        });
      });
    }
  }

  /**
   * D-Pad / Пульт Smart TV & Проектора (Spatial Navigation за стандартом Roving Tabindex)
   */
  setupSpatialNavigation() {
    const containers = [
      document.getElementById("projectorDock"),
      document.getElementById("presetGrid"),
      document.getElementById("sourceContainer"),
    ];

    containers.forEach((container) => {
      if (!container) return;

      container.addEventListener("keydown", (e) => {
        const dirMap = {
          ArrowRight: "right",
          ArrowLeft: "left",
          ArrowDown: "down",
          ArrowUp: "up",
        };
        const dir = dirMap[e.key];
        if (!dir) return;

        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) {
          return;
        }

        const innerTarget = e.composedPath()[0];
        if (
          innerTarget instanceof Element &&
          innerTarget.matches(':read-write, select, input[type="range"], [role="slider"]')
        ) {
          return;
        }

        const candidates = Array.from(
          container.querySelectorAll("button, [tabindex]")
        ).filter((el) => el.checkVisibility && el.checkVisibility());

        const current = document.activeElement;
        if (!candidates.includes(current)) {
          const defaultTarget = container.querySelector(".active") || candidates[0];
          if (defaultTarget) {
            e.preventDefault();
            candidates.forEach((c) =>
              c.setAttribute("tabindex", c === defaultTarget ? "0" : "-1")
            );
            defaultTarget.focus();
            defaultTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
          return;
        }

        const currRect = current.getBoundingClientRect();
        const tolerance = 2;

        const validCandidates = candidates
          .filter((el) => el !== current)
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => {
            if (dir === "right") return rect.left >= currRect.right - tolerance;
            if (dir === "left") return rect.right <= currRect.left + tolerance;
            if (dir === "down") return rect.top >= currRect.bottom - tolerance;
            if (dir === "up") return rect.bottom <= currRect.top + tolerance;
            return false;
          });

        if (validCandidates.length === 0) {
          return;
        }

        const isHorizontal = dir === "left" || dir === "right";
        const currCenterPerp = isHorizontal
          ? (currRect.top + currRect.bottom) / 2
          : (currRect.left + currRect.right) / 2;

        const scored = validCandidates.map(({ el, rect }) => {
          const gap =
            dir === "right"
              ? Math.max(0, rect.left - currRect.right)
              : dir === "left"
              ? Math.max(0, currRect.left - rect.right)
              : dir === "down"
              ? Math.max(0, rect.top - currRect.bottom)
              : Math.max(0, currRect.top - rect.bottom);

          const overlapsPerp = isHorizontal
            ? rect.bottom > currRect.top && rect.top < currRect.bottom
            : rect.right > currRect.left && rect.left < currRect.right;

          const candCenterPerp = isHorizontal
            ? (rect.top + currRect.bottom) / 2
            : (rect.left + rect.right) / 2;
          const perpOffset = Math.abs(candCenterPerp - currCenterPerp);

          return { el, gap, overlapsPerp, perpOffset };
        });

        const aligned = scored.filter((c) => c.overlapsPerp);
        let winner;
        if (aligned.length > 0) {
          aligned.sort((a, b) => a.gap - b.gap || a.perpOffset - b.perpOffset);
          winner = aligned[0].el;
        } else {
          const w = 2.5;
          scored.sort(
            (a, b) =>
              a.gap + w * a.perpOffset - (b.gap + w * b.perpOffset)
          );
          winner = scored[0].el;
        }

        if (winner) {
          e.preventDefault();
          candidates.forEach((c) =>
            c.setAttribute("tabindex", c === winner ? "0" : "-1")
          );
          winner.focus();
          winner.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      });
    });
  }

  setupAutoHideHud() {
    const triggerActivity = () => {
      if (this.currentView === "projector" && !this.projectorHudCollapsed) {
        this.resetHudTimer();
      }
    };
    window.addEventListener("pointermove", triggerActivity);
    window.addEventListener("pointerdown", triggerActivity);
    window.addEventListener("keydown", triggerActivity);
  }

  resetHudTimer() {
    if (this.projectorHudCollapsed) return;
    const dock = document.getElementById("projectorDock");
    if (!dock) return;
    dock.classList.remove("hud-hidden");
    clearTimeout(this.hudTimeout);
    this.hudTimeout = setTimeout(() => {
      if (this.currentView === "projector") {
        dock.classList.add("hud-hidden");
      }
    }, 4000);
  }

  setupProjectorHudControls() {
    const btnRemoteToggle = document.getElementById("btnRemoteToggleHud");
    if (btnRemoteToggle) {
      btnRemoteToggle.addEventListener("click", () => this.toggleProjectorHud());
    }

    const btnTopBarToggle = document.getElementById("btnToggleProjectorHud");
    if (btnTopBarToggle) {
      btnTopBarToggle.addEventListener("click", () => this.toggleProjectorHud());
    }

    const btnDockToggle = document.getElementById("btnDockToggleHud");
    if (btnDockToggle) {
      btnDockToggle.addEventListener("click", () => this.toggleProjectorHud());
    }

    const btnFloatingRestore = document.getElementById("btnFloatingRestoreHud");
    if (btnFloatingRestore) {
      btnFloatingRestore.addEventListener("click", () => this.setProjectorHudCollapsed(false, true));
    }

    const btnRemoteUpdate = document.getElementById("btnRemoteUpdateApk");
    if (btnRemoteUpdate) {
      btnRemoteUpdate.addEventListener("click", () => {
        if (
          confirm(
            "Запустити оновлення AURA VJ на проекторі?\n\nПроектор завантажить оновлений APK з GitHub Releases і відкриє встановлення."
          )
        ) {
          if (
            window.AndroidAudioBridge &&
            typeof window.AndroidAudioBridge.updateApk === "function"
          ) {
            window.AndroidAudioBridge.updateApk();
          } else {
            this.sync.send({ type: "triggerApkUpdate" });
          }
        }
      });
    }

    const btnBannerUpdate = document.getElementById("btnBannerUpdateApk");
    if (btnBannerUpdate) {
      btnBannerUpdate.addEventListener("click", () => {
        if (
          window.AndroidAudioBridge &&
          typeof window.AndroidAudioBridge.updateApk === "function"
        ) {
          window.AndroidAudioBridge.updateApk();
        }
      });
    }

    const btnCloseApkBanner = document.getElementById("btnCloseApkBanner");
    if (btnCloseApkBanner) {
      btnCloseApkBanner.addEventListener("click", () => {
        const banner = document.getElementById("apkUpdateBanner");
        if (banner) banner.style.display = "none";
        try {
          sessionStorage.setItem("aura_apk_update_dismissed", "true");
        } catch {}
        if (window.AndroidAudioBridge && typeof window.AndroidAudioBridge.dismissApkUpdate === "function") {
          window.AndroidAudioBridge.dismissApkUpdate(this.currentApkReleaseId || "");
        }
      });
    }

    window.onApkUpdateAvailable = (releaseId) => {
      this.currentApkReleaseId = releaseId;
      try {
        if (sessionStorage.getItem("aura_apk_update_dismissed") === "true") return;
      } catch {}
      const banner = document.getElementById("apkUpdateBanner");
      if (banner) {
        banner.style.display = "flex";
        // Автоматично приховуємо через 10 секунд, щоб не висіло постійно на екрані
        setTimeout(() => {
          if (banner) banner.style.display = "none";
        }, 10000);
      }
      const btnNative = document.getElementById("btnUpdateApkNative");
      if (btnNative) btnNative.style.display = "block";
    };

    // На проекторі: якщо меню згорнуто, при русі миші чи дотику показуємо плаваючу кнопку відновлення на 3.5 с
    let restoreTimeout = null;
    const showRestorePill = () => {
      if (this.projectorHudCollapsed && (this.currentView === "projector" || this.currentView === "split")) {
        document.body.classList.add("restore-pill-visible");
        clearTimeout(restoreTimeout);
        restoreTimeout = setTimeout(() => {
          document.body.classList.remove("restore-pill-visible");
        }, 3500);
      }
    };

    const stage = document.getElementById("projectorStage");
    if (stage) {
      stage.addEventListener("pointermove", (e) => {
        if (e.clientY < 90 || e.clientY > window.innerHeight - 90) {
          showRestorePill();
        }
      });
      stage.addEventListener("pointerdown", () => {
        showRestorePill();
      });
    }

    this.updateProjectorHudUI();
  }

  toggleProjectorHud() {
    this.setProjectorHudCollapsed(!this.projectorHudCollapsed, true);
  }

  setProjectorHudCollapsed(collapsed, broadcast = true) {
    this.projectorHudCollapsed = !!collapsed;

    try {
      localStorage.setItem("aura_projector_hud_collapsed", this.projectorHudCollapsed ? "true" : "false");
    } catch {}

    // Застосовуємо до проектора або split режиму (на пульті телефону інтерфейс не ховаємо)
    if (this.currentView === "projector" || this.currentView === "split") {
      document.body.classList.toggle("projector-hud-collapsed", this.projectorHudCollapsed);
      if (this.visualizer && typeof this.visualizer.applyCanvasResolution === "function") {
        setTimeout(() => this.visualizer.applyCanvasResolution(), 60);
      }
    } else {
      document.body.classList.remove("projector-hud-collapsed");
    }

    this.updateProjectorHudUI();

    if (broadcast) {
      this.sync.send({
        type: "setProjectorHud",
        collapsed: this.projectorHudCollapsed,
      });
    }
  }

  updateProjectorHudUI() {
    const isCollapsed = !!this.projectorHudCollapsed;

    // 1. Панель на мобільному пульті
    const remoteBar = document.getElementById("projectorRemoteBar");
    if (remoteBar) {
      remoteBar.classList.toggle("hud-collapsed", isCollapsed);
    }
    const txtRemoteState = document.getElementById("txtRemoteProjectorHudState");
    if (txtRemoteState) {
      txtRemoteState.textContent = isCollapsed
        ? "Чистий екран (Меню згорнуто) 🎬"
        : "Меню видимі";
    }
    const lblRemoteToggle = document.getElementById("lblRemoteToggleHud");
    if (lblRemoteToggle) {
      lblRemoteToggle.textContent = isCollapsed ? "Розгорнути меню" : "Згорнути меню";
    }
    const btnRemoteToggle = document.getElementById("btnRemoteToggleHud");
    if (btnRemoteToggle) {
      btnRemoteToggle.classList.toggle("active", isCollapsed);
      btnRemoteToggle.title = isCollapsed
        ? "Розгорнути верхнє та нижнє меню на проекторі"
        : "Згорнути верхнє та нижнє меню на проекторі (Чистий екран)";
    }
    const icoRemoteHud = document.getElementById("icoRemoteHud");
    if (icoRemoteHud) {
      icoRemoteHud.innerHTML = isCollapsed
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }

    // 2. Кнопка у верхньому барі
    const btnTopBar = document.getElementById("btnToggleProjectorHud");
    const txtTopBar = document.getElementById("txtTopBarHud");
    const icoTopBar = document.getElementById("icoTopBarHud");
    if (btnTopBar) {
      btnTopBar.classList.toggle("active", isCollapsed);
    }
    if (txtTopBar) {
      txtTopBar.textContent = isCollapsed ? "МЕНЮ: СХОВАНО" : "МЕНЮ: ВКЛ";
    }
    if (icoTopBar) {
      icoTopBar.innerHTML = isCollapsed
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }

    // 3. Кнопка у нижньому доці проектора
    const btnDock = document.getElementById("btnDockToggleHud");
    if (btnDock) {
      btnDock.classList.toggle("active", isCollapsed);
    }
  }

  /**
   * Гарячі клавіші для професійного VJ-контролю на Десктопі / Ноутбуку
   */
  setupDesktopShortcuts() {
    const sceneKeyMap = {
      "1": "lasers",
      "2": "blobtrack",
      "3": "pointcloud",
      "4": "reaction",
      "5": "synthwave",
      "6": "ferrofluid",
      "7": "tunnel",
      "8": "liquid",
      "9": "fractal",
    };

    const tabKeyMap = {
      q: "tabScenes",
      e: "tabFilmoraFx",
      r: "tabTdNodes",
      t: "tabMediaTop",
      a: "tabAll",
    };

    const btnStrobe = document.getElementById("fxStrobe");
    const btnShockwave = document.getElementById("fxShockwave");
    const btnFreeze = document.getElementById("fxFreeze");
    const btnColorDrop = document.getElementById("fxColorDrop");
    const shortcutsModal = document.getElementById("shortcutsModal");

    const setStrobe = (active) => {
      this.visualizer.fx.strobe = active;
      if (btnStrobe) btnStrobe.classList.toggle("active", active);
      this.sync.send({ type: "fx", effect: "strobe", active });
    };

    window.addEventListener("keydown", (e) => {
      // Пропускаємо, якщо користувач вводить текст у поле чи форму
      const target = e.target;
      if (
        target instanceof Element &&
        (target.matches("input, textarea, select, [contenteditable='true']") ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      // Escape закриває активні модалки
      if (e.key === "Escape") {
        if (shortcutsModal && !shortcutsModal.hidden) {
          shortcutsModal.hidden = true;
          return;
        }
        const qrModal = document.getElementById("qrModal");
        if (qrModal && !qrModal.hidden) {
          qrModal.hidden = true;
          return;
        }
        const proModal = document.getElementById("proModal");
        if (proModal && !proModal.hidden) {
          proModal.hidden = true;
          return;
        }
      }

      // Довідка гарячих клавіш: ? або H
      if (e.key === "?" || e.key.toLowerCase() === "h") {
        e.preventDefault();
        if (shortcutsModal) {
          shortcutsModal.hidden = !shortcutsModal.hidden;
        }
        return;
      }

      // Сцени 1-9
      if (sceneKeyMap[e.key]) {
        e.preventDefault();
        const mode = sceneKeyMap[e.key];
        if (typeof this.selectMode === "function") {
          this.selectMode(mode);
        } else {
          this.visualizer.setMode(mode);
          this.highlightModeButtons(mode);
          this.sync.send({ type: "mode", mode });
        }
        const pad = document.querySelector(`.vj-pad[data-mode="${mode}"]`);
        if (pad) {
          pad.classList.add("active");
          pad.focus();
        }
        return;
      }

      // TRG-01: STROBE (Space)
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) {
          setStrobe(true);
        }
        return;
      }

      // TRG-02: SHOCKWAVE (W)
      if (e.key.toLowerCase() === "w") {
        e.preventDefault();
        this.visualizer.triggerShockwave();
        if (btnShockwave) {
          btnShockwave.classList.add("active");
          setTimeout(() => btnShockwave.classList.remove("active"), 140);
        }
        this.sync.send({ type: "fx", effect: "shockwave" });
        return;
      }

      // TRG-03: FREEZE (F)
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        const active = !this.visualizer.fx.freeze;
        this.visualizer.fx.freeze = active;
        if (btnFreeze) btnFreeze.classList.toggle("active", active);
        this.sync.send({ type: "fx", effect: "freeze", active });
        return;
      }

      // TRG-04: PALETTE DROP (C)
      if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        this.visualizer.triggerColorDrop();
        if (btnColorDrop) {
          btnColorDrop.classList.add("active");
          setTimeout(() => btnColorDrop.classList.remove("active"), 140);
        }
        this.sync.send({
          type: "fx",
          effect: "colordrop",
          colorShift: this.visualizer.colorShift,
        });
        return;
      }

      // Згортання/розгортання меню проектора: U
      if (e.key.toLowerCase() === "u") {
        e.preventDefault();
        this.toggleProjectorHud();
        return;
      }

      // Перемикання вкладок студії: Q, E, R, T, A
      const k = e.key.toLowerCase();
      if (tabKeyMap[k]) {
        e.preventDefault();
        const tabTarget = tabKeyMap[k];
        const tabBtn = document.querySelector(`.studio-tab[data-tab="${tabTarget}"]`);
        if (tabBtn) tabBtn.click();
        return;
      }

      // Перемикання монітора звуку: M
      if (k === "m") {
        e.preventDefault();
        const chk = document.getElementById("chkSynthAudio");
        if (chk) {
          chk.checked = !chk.checked;
          chk.dispatchEvent(new Event("change"));
        }
        return;
      }

      // Перемикання Live Program Monitor прев'ю на пульті: P
      if (k === "p") {
        e.preventDefault();
        this.toggleProgramMonitor();
        return;
      }

      // Перемикання режимів екрана: V
      if (k === "v") {
        e.preventDefault();
        const views = ["split", "projector", "remote"];
        const nextIdx = (views.indexOf(this.currentView) + 1) % views.length;
        this.setView(views[nextIdx]);
        return;
      }

      // Відкрити вікно підключення / QR: N
      if (k === "n") {
        e.preventDefault();
        const qrModal = document.getElementById("qrModal");
        if (qrModal) {
          qrModal.hidden = !qrModal.hidden;
          if (!qrModal.hidden) this.renderQrModal();
        }
        return;
      }

      // Стрілки клавіатури для точного зміщення XY Puck
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        const step = 0.04;
        let curX = this.visualizer.xy ? this.visualizer.xy.x : 0.5;
        let curY = this.visualizer.xy ? this.visualizer.xy.y : 0.5;
        if (e.key === "ArrowLeft") curX = Math.max(0, curX - step);
        if (e.key === "ArrowRight") curX = Math.min(1, curX + step);
        if (e.key === "ArrowDown") curY = Math.max(0, curY - step);
        if (e.key === "ArrowUp") curY = Math.min(1, curY + step);
        e.preventDefault();
        this.updateXYUI(curX, curY);
        this.visualizer.setXY(curX, curY);
        this.sync.send({ type: "xy", x: curX, y: curY });
      }
    });

    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        setStrobe(false);
      }
    });

    window.addEventListener("blur", () => {
      setStrobe(false);
    });
  }

  /**
   * Розширені можливості маніпуляції мишею на десктопі
   */
  setupDesktopMouseInteractions() {
    const xyPad = document.getElementById("xyPad");
    if (xyPad) {
      // Подвійний клік повертає puck у центр (50%, 50%)
      xyPad.addEventListener("dblclick", () => {
        this.updateXYUI(0.5, 0.5);
        this.visualizer.setXY(0.5, 0.5);
        this.sync.send({ type: "xy", x: 0.5, y: 0.5 });
      });
    }

    // Тонке регулювання коліщатком миші над фейдерами
    document.querySelectorAll('input[type="range"]').forEach((slider) => {
      slider.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const step = Number(slider.step) || 2;
          const delta = e.deltaY < 0 ? step : -step;
          const min = Number(slider.min) || 0;
          const max = Number(slider.max) || 100;
          const current = Number(slider.value) || 0;
          const next = Math.max(min, Math.min(max, current + delta));
          if (next !== current) {
            slider.value = next;
            slider.dispatchEvent(new Event("input", { bubbles: true }));
          }
        },
        { passive: false }
      );

      // Подвійний клік скидає слайдер на значення за замовчуванням
      slider.addEventListener("dblclick", () => {
        const defaultVal =
          slider.id === "rangeKeystoneScale"
            ? 100
            : Number(slider.min) || 0;
        slider.value = defaultVal;
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });

    // Відкриття та закриття модалки гарячих клавіш
    const btnShortcuts = document.getElementById("btnShortcuts");
    const modal = document.getElementById("shortcutsModal");
    const btnClose = document.getElementById("btnCloseShortcuts");
    if (btnShortcuts && modal) {
      btnShortcuts.addEventListener("click", () => {
        modal.hidden = false;
      });
    }
    if (btnClose && modal) {
      btnClose.addEventListener("click", () => {
        modal.hidden = true;
      });
    }
  }

  generateQrSvg(text, opt = {}) {
    const ecLevel = opt.ecLevel || "L";
    const margin = opt.margin !== undefined ? opt.margin : 2;
    const size = opt.size || 196;

    const EXP = new Uint8Array(512);
    const LOG = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; EXP[i + 255] = x; LOG[x] = i;
      x = (x << 1) ^ (x >= 128 ? 0x11D : 0);
    }
    const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

    const rsPoly = (n) => {
      let p = [1];
      for (let i = 0; i < n; i++) {
        const next = new Array(p.length + 1).fill(0);
        for (let j = 0; j < p.length; j++) {
          next[j] ^= gfMul(p[j], EXP[i]);
          next[j + 1] ^= p[j];
        }
        p = next;
      }
      return p;
    };

    const rsCalc = (data, numEc) => {
      const gen = rsPoly(numEc);
      const msg = new Array(data.length + numEc).fill(0);
      for (let i = 0; i < data.length; i++) msg[i] = data[i];
      for (let i = 0; i < data.length; i++) {
        const c = msg[i];
        if (c !== 0) {
          for (let j = 0; j < gen.length; j++) msg[i + j] ^= gfMul(gen[j], c);
        }
      }
      return msg.slice(data.length);
    };

    const V = [
      null,
      { v: 1, s: 21, dL: 19, ecL: 7, dM: 16, ecM: 10, a: [] },
      { v: 2, s: 25, dL: 34, ecL: 10, dM: 28, ecM: 16, a: [6, 18] },
      { v: 3, s: 29, dL: 55, ecL: 15, dM: 44, ecM: 26, a: [6, 22] },
      { v: 4, s: 33, dL: 80, ecL: 20, dM: 64, ecM: 36, a: [6, 26] },
      { v: 5, s: 37, dL: 108, ecL: 26, dM: 86, ecM: 48, a: [6, 30] },
      { v: 6, s: 41, dL: 136, ecL: 36, dM: 108, ecM: 64, a: [6, 34] },
      { v: 7, s: 45, dL: 156, ecL: 40, dM: 124, ecM: 72, a: [6, 22, 38] },
    ];

    const strBytes = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 128) strBytes.push(code);
      else if (code < 2048) { strBytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F)); }
      else { strBytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F)); }
    }

    let vi = null;
    const isM = ecLevel === "M";
    for (let i = 1; i < V.length; i++) {
      const cap = isM ? V[i].dM : V[i].dL;
      if (strBytes.length + 3 <= cap) { vi = V[i]; break; }
    }
    if (!vi) vi = V[V.length - 1];

    const totalData = isM ? vi.dM : vi.dL;
    const totalEc = isM ? vi.ecM : vi.ecL;

    const bits = [0, 1, 0, 0];
    const lenBits = 8;
    for (let i = lenBits - 1; i >= 0; i--) bits.push((strBytes.length >> i) & 1);
    for (const b of strBytes) {
      for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    }
    for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const dataBytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataBytes.push(b);
    }
    let pad = 0;
    while (dataBytes.length < totalData) {
      dataBytes.push(pad % 2 === 0 ? 0xEC : 0x11);
      pad++;
    }

    const ecBytes = rsCalc(dataBytes, totalEc);
    const finalCodewords = dataBytes.concat(ecBytes);

    const N = vi.s;
    const mat = Array.from({ length: N }, () => new Int8Array(N).fill(-1));

    const addFinder = (r0, c0) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
          const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          mat[r0 + r][c0 + c] = (isBorder || isCenter) ? 1 : 0;
        }
      }
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          if (r === -1 || r === 7 || c === -1 || c === 7) {
            const rr = r0 + r, cc = c0 + c;
            if (rr >= 0 && rr < N && cc >= 0 && cc < N) mat[rr][cc] = 0;
          }
        }
      }
    };
    addFinder(0, 0);
    addFinder(0, N - 7);
    addFinder(N - 7, 0);

    if (vi.a.length > 0) {
      for (const r of vi.a) {
        for (const c of vi.a) {
          if (mat[r][c] !== -1) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const isBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2;
              const isCenter = dr === 0 && dc === 0;
              mat[r + dr][c + dc] = (isBorder || isCenter) ? 1 : 0;
            }
          }
        }
      }
    }

    for (let i = 8; i < N - 8; i++) {
      if (mat[6][i] === -1) mat[6][i] = (i % 2 === 0) ? 1 : 0;
      if (mat[i][6] === -1) mat[i][6] = (i % 2 === 0) ? 1 : 0;
    }

    mat[4 * vi.v + 9][8] = 1;

    for (let i = 0; i < 9; i++) {
      if (mat[8][i] === -1) mat[8][i] = 0;
      if (mat[i][8] === -1) mat[i][8] = 0;
      if (mat[8][N - 1 - i] === -1) mat[8][N - 1 - i] = 0;
      if (mat[N - 1 - i][8] === -1) mat[N - 1 - i] = 0;
    }

    const allBits = [];
    for (const b of finalCodewords) {
      for (let i = 7; i >= 0; i--) allBits.push((b >> i) & 1);
    }

    let bitIdx = 0;
    let dir = -1;
    let col = N - 1;
    while (col > 0) {
      if (col === 6) col--;
      const rows = dir === -1 ? Array.from({ length: N }, (_, i) => N - 1 - i) : Array.from({ length: N }, (_, i) => i);
      for (const r of rows) {
        for (const c of [col, col - 1]) {
          if (mat[r][c] === -1) {
            mat[r][c] = bitIdx < allBits.length ? allBits[bitIdx++] : 0;
          }
        }
      }
      dir = -dir;
      col -= 2;
    }

    const maskFn = (r, c) => (r + c) % 2 === 0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const isFinder = (r < 9 && c < 9) || (r < 9 && c >= N - 8) || (r >= N - 8 && c < 9);
        const isTiming = (r === 6 || c === 6);
        let isAlign = false;
        if (vi.a.length > 0) {
          for (const ar of vi.a) {
            for (const ac of vi.a) {
              if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) isAlign = true;
            }
          }
        }
        if (!isFinder && !isTiming && !isAlign) {
          if (maskFn(r, c)) mat[r][c] ^= 1;
        }
      }
    }

    const formatInt = isM ? 0x5412 : 0x5C41;
    const fBits = [];
    for (let i = 14; i >= 0; i--) fBits.push((formatInt >> i) & 1);

    mat[8][0] = fBits[0]; mat[8][1] = fBits[1]; mat[8][2] = fBits[2]; mat[8][3] = fBits[3];
    mat[8][4] = fBits[4]; mat[8][5] = fBits[5]; mat[8][7] = fBits[6]; mat[8][8] = fBits[7];
    mat[7][8] = fBits[8]; mat[5][8] = fBits[9]; mat[4][8] = fBits[10]; mat[3][8] = fBits[11];
    mat[2][8] = fBits[12]; mat[1][8] = fBits[13]; mat[0][8] = fBits[14];

    for (let i = 0; i < 7; i++) mat[8][N - 1 - i] = fBits[i];
    for (let i = 0; i < 8; i++) mat[N - 8 + i][8] = fBits[7 + i];

    const totalDim = N + margin * 2;
    let paths = "";
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (mat[r][c] === 1) {
          paths += `M${c + margin},${r + margin}h1v1h-1z `;
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalDim} ${totalDim}" width="${size}" height="${size}" style="border-radius:10px;background:#ffffff;display:block;margin:0 auto;box-shadow:0 8px 24px rgba(0,0,0,0.5);"><path fill="#000000" d="${paths.trim()}"/></svg>`;
  }

  renderQrModal() {
    const rawHost = this.sync.serverHost || (location.host || "192.168.0.40:3456");
    const ip = rawHost.split(":")[0];
    const httpsHost = `${ip}:3457`;
    const httpHost = `${ip}:3456`;

    if (!this.qrMode) this.qrMode = "https";

    const remoteHttpsUrl = `https://${httpsHost}/?view=remote&room=${encodeURIComponent(this.sync.roomId)}`;
    const remoteHttpUrl = `http://${httpHost}/?view=remote&room=${encodeURIComponent(this.sync.roomId)}`;
    const projectorUrl = `http://${httpHost}/?view=projector&room=${encodeURIComponent(this.sync.roomId)}`;

    const activeRemoteUrl = this.qrMode === "http" ? remoteHttpUrl : remoteHttpsUrl;

    const btnHttps = document.getElementById("btnQrModeHttps");
    const btnHttp = document.getElementById("btnQrModeHttp");
    if (btnHttps && btnHttp) {
      btnHttps.classList.toggle("active", this.qrMode === "https");
      btnHttp.classList.toggle("active", this.qrMode === "http");

      btnHttps.onclick = () => {
        this.qrMode = "https";
        this.renderQrModal();
      };
      btnHttp.onclick = () => {
        this.qrMode = "http";
        this.renderQrModal();
      };
    }

    const remoteUrlEl = document.getElementById("remoteUrlText");
    if (remoteUrlEl) {
      remoteUrlEl.innerHTML = `
        <div style="margin-bottom:6px;"><strong>${this.qrMode === "https" ? "📱 Пульт (HTTPS з мікрофоном):" : "📱 Пульт (HTTP швидкий старт):"}</strong></div>
        <div style="word-break:break-all;color:var(--neon);font-family:monospace;font-size:12px;margin-bottom:8px;">${activeRemoteUrl}</div>
        <div style="opacity:0.75;font-size:11px;">📽️ Екран (Smart TV / Проектор): <code>${projectorUrl}</code></div>
      `;
    }

    const btnCopy = document.getElementById("btnCopyRemoteUrl");
    if (btnCopy) {
      btnCopy.onclick = () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(activeRemoteUrl).then(() => {
            btnCopy.textContent = "✅ СКОПІЙОВАНО!";
            btnCopy.classList.add("copied");
            setTimeout(() => {
              btnCopy.textContent = "📋 СКОПІЮВАТИ ПОСИЛАННЯ";
              btnCopy.classList.remove("copied");
            }, 2500);
          }).catch(() => {});
        }
      };
    }

    const roomInput = document.getElementById("roomInput");
    if (roomInput) roomInput.value = this.sync.roomId;

    // Генеруємо векторний QR-код 100% автономно офлайн без зовнішніх API
    const qrBox = document.getElementById("qrCodeBox");
    if (qrBox) {
      try {
        qrBox.innerHTML = this.generateQrSvg(activeRemoteUrl, { size: 196, ecLevel: "L" });
      } catch (e) {
        // Fallback на аварійний прямий тег, якщо DOM обмежений
        const encoded = encodeURIComponent(activeRemoteUrl);
        qrBox.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}" alt="QR Code" />`;
      }
    }
  }

  loadSavedCustomEffects() {
    const studioBtn = document.getElementById("btnOpenStudio");
    if (studioBtn) {
      studioBtn.href = `studio.html?room=${encodeURIComponent(this.sync.roomId)}`;
    }
    try {
      const raw = localStorage.getItem("aura_vj_custom_effects");
      const list = raw ? JSON.parse(raw) : [];
      list.forEach((eff) => this.installCustomEffect(eff, false, false));
    } catch {
      // ignore
    }
  }

  installCustomEffect(effect, activateNow = true, persist = true) {
    if (!effect || !effect.id) return;
    this.visualizer.registerCustomEffect(effect);

    if (persist) {
      try {
        const raw = localStorage.getItem("aura_vj_custom_effects");
        const list = raw ? JSON.parse(raw) : [];
        const existingIdx = list.findIndex((item) => item.id === effect.id);
        if (existingIdx !== -1) list[existingIdx] = effect;
        else list.push(effect);
        localStorage.setItem("aura_vj_custom_effects", JSON.stringify(list));
      } catch {
        // ignore
      }
    }

    // 1. Додаємо або оновлюємо кнопку на пульті смартфона (#presetGrid)
    const grid = document.getElementById("presetGrid");
    if (grid) {
      let pad = grid.querySelector(`[data-mode="${effect.id}"]`);
      if (!pad) {
        pad = document.createElement("button");
        pad.className = "vj-pad custom-vj-pad";
        pad.dataset.mode = effect.id;
        pad.setAttribute("tabindex", "-1");
        pad.addEventListener("click", () => {
          this.visualizer.setMode(effect.id);
          if (effect.postFx || effect.chopRouting) {
            this.applyPatchState(effect);
          }
          this.highlightModeButtons(effect.id);
          this.sync.send({ type: "installCustomEffect", effect });
        });
        grid.appendChild(pad);
      }
      pad.innerHTML = `
        <div class="pad-top-row">
          <svg class="ico" viewBox="0 0 24 24"><polygon points="12 2 15 9 22 12 15 15 12 22 9 15 2 12 9 9 12 2"/></svg>
          <span class="pad-code">${effect.emoji || "USR-FX"}</span>
        </div>
        <span class="pad-name">${effect.name || "Custom FX"}</span>
        <span class="pad-sub">${effect.sub || "FX Studio"}</span>
      `;
    }

    // 2. Додаємо або оновлюємо кнопку в док-панелі проектора (#projectorDock)
    const dock = document.getElementById("projectorDock");
    const qrBtn = document.getElementById("btnQrModal");
    if (dock) {
      let dockBtn = dock.querySelector(`[data-mode="${effect.id}"]`);
      if (!dockBtn) {
        dockBtn = document.createElement("button");
        dockBtn.className = "dock-item";
        dockBtn.dataset.mode = effect.id;
        dockBtn.setAttribute("tabindex", "-1");
        dockBtn.addEventListener("click", () => {
          this.visualizer.setMode(effect.id);
          if (effect.postFx || effect.chopRouting) {
            this.applyPatchState(effect);
          }
          this.highlightModeButtons(effect.id);
          this.sync.send({ type: "installCustomEffect", effect });
        });
        if (qrBtn) dock.insertBefore(dockBtn, qrBtn);
        else dock.appendChild(dockBtn);
      }
      dockBtn.innerHTML = `
        <svg class="ico" viewBox="0 0 24 24"><polygon points="12 2 15 9 22 12 15 15 12 22 9 15 2 12 9 9 12 2"/></svg>
        <span class="dock-label">${effect.name || "Custom FX"}</span>
      `;
    }

    if (activateNow) {
      this.visualizer.setMode(effect.id);
      this.applyPatchState(effect);
      this.highlightModeButtons(effect.id);
    }
  }

  handleSyncMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "syncStatus") {
      const badge = document.getElementById("btnRoomBadge");
      const studioBtn = document.getElementById("btnOpenStudio");
      if (msg.roomId) {
        this.visualizer.roomId = msg.roomId;
      }
      if (badge) {
        badge.classList.toggle("online", !!msg.connected);
        badge.classList.toggle("p2p-active", !!msg.p2p);
      }
      if (studioBtn && msg.roomId) {
        studioBtn.href = `studio.html?room=${encodeURIComponent(msg.roomId)}`;
      }
      const isStillLinked =
        this.lastPeerHeartbeat &&
        performance.now() - this.lastPeerHeartbeat < 16000;
      this.updatePeerStatusUI(!!isStillLinked);
      return;
    }

    // Будь-який пакет від іншого учасника кімнати підтверджує активний зв'язок
    this.lastPeerHeartbeat = performance.now();
    this.updatePeerStatusUI(true, msg.role);

    if (msg.type === "peerHeartbeat") {
      if (typeof msg.hudCollapsed === "boolean") {
        this.setProjectorHudCollapsed(msg.hudCollapsed, false);
      }
      // Відповідаємо синхронізацією стану підключеному пристрою
      if (msg.isPing && !msg.isPong) {
        const stateSyncPacket = {
          type: "stateSync",
          isPong: true,
          mode: this.visualizer.modes[this.visualizer.modeIndex],
          isPro: this.isPro,
          hudCollapsed: this.projectorHudCollapsed,
          xy: { ...this.visualizer.xy },
          colorShift: this.visualizer.colorShift,
          postFx: { ...this.visualizer.postFx },
          chopRouting: { ...this.visualizer.chopRouting },
          mediaMix: this.visualizer.mediaMix,
          mediaMode: this.visualizer.mediaBlendMode,
        };
        const imgEl = document.getElementById("customImageEl");
        if (imgEl && imgEl.src && imgEl.src.startsWith("data:image")) {
          stateSyncPacket.mediaDataUrl = imgEl.src;
        }
        this.sync.send(stateSyncPacket);
      }
    } else if (msg.type === "stateSync") {
      if (typeof msg.hudCollapsed === "boolean") {
        this.setProjectorHudCollapsed(msg.hudCollapsed, false);
      }
      if (msg.mode) {
        this.visualizer.setMode(msg.mode);
        this.highlightModeButtons(msg.mode);
      }
      if (typeof msg.isPro === "boolean") {
        this.setProStatus(msg.isPro, false);
      }
      if (msg.xy && typeof msg.xy.x === "number") {
        this.visualizer.setXY(msg.xy.x, msg.xy.y);
        this.updateXYUI(msg.xy.x, msg.xy.y);
      }
      if (typeof msg.colorShift === "number") {
        this.visualizer.colorShift = msg.colorShift;
      }
      if (msg.postFx || msg.chopRouting) {
        this.applyPatchState(msg);
      }
      if (typeof msg.mediaMix === "number") {
        this.visualizer.mediaMix = msg.mediaMix;
      }
      if (typeof msg.mediaMode === "number") {
        this.visualizer.mediaBlendMode = msg.mediaMode;
      }
      if (msg.mediaDataUrl) {
        const imgEl = document.getElementById("customImageEl");
        if (imgEl) {
          imgEl.onload = () => {
            this.visualizer.setMediaSource(imgEl);
          };
          imgEl.src = msg.mediaDataUrl;
        }
      }
    } else if (msg.type === "setProjectorHud") {
      this.setProjectorHudCollapsed(!!msg.collapsed, false);
    } else if (msg.type === "triggerApkUpdate") {
      if (
        window.AndroidAudioBridge &&
        typeof window.AndroidAudioBridge.updateApk === "function"
      ) {
        window.AndroidAudioBridge.updateApk();
      }
    } else if (msg.type === "proStatus") {
      this.setProStatus(!!msg.isPro, false);
    } else if (msg.type === "venueKeystone") {
      if (msg.venueOverlay) {
        this.visualizer.venueOverlay = msg.venueOverlay;
        const chkVenue = document.getElementById("chkVenueOverlay");
        const inputTitle = document.getElementById("inputVenueTitle");
        const inputSub = document.getElementById("inputVenueSub");
        if (chkVenue) chkVenue.checked = !!msg.venueOverlay.enabled;
        if (inputTitle && msg.venueOverlay.title !== undefined) inputTitle.value = msg.venueOverlay.title;
        if (inputSub && msg.venueOverlay.subtitle !== undefined) inputSub.value = msg.venueOverlay.subtitle;
      }
      if (msg.keystone) {
        this.visualizer.keystone = msg.keystone;
        const rangeScale = document.getElementById("rangeKeystoneScale");
        const valScale = document.getElementById("val_keystoneScale");
        const rangeCrop = document.getElementById("rangeKeystoneCrop");
        const valCrop = document.getElementById("val_keystoneCrop");
        if (rangeScale && typeof msg.keystone.scale === "number") {
          rangeScale.value = String(Math.round(msg.keystone.scale * 100));
          if (valScale) valScale.textContent = `${rangeScale.value}%`;
        }
        if (rangeCrop && typeof msg.keystone.cropX === "number") {
          rangeCrop.value = String(Math.round(msg.keystone.cropX * 100));
          if (valCrop) valCrop.textContent = `${rangeCrop.value}%`;
        }
      }
    } else if (msg.type === "mediaConfig") {
      if (typeof msg.mix === "number") {
        this.visualizer.mediaMix = msg.mix;
        const rangeMix = document.getElementById("rangeMediaMix");
        const valMix = document.getElementById("val_mediaMix");
        if (rangeMix) rangeMix.value = String(Math.round(msg.mix * 100));
        if (valMix) valMix.textContent = `${Math.round(msg.mix * 100)}%`;
      }
      if (typeof msg.mode === "number") {
        this.visualizer.mediaBlendMode = msg.mode;
        document.querySelectorAll("[data-media-mode]").forEach((c) => {
          c.classList.toggle("active", Number(c.dataset.mediaMode) === msg.mode);
        });
      }
    } else if (msg.type === "mediaImage" && msg.dataUrl) {
      const imgEl = document.getElementById("customImageEl");
      const btnUpload = document.getElementById("btnUploadMedia");
      if (imgEl) {
        imgEl.onload = () => {
          this.visualizer.setMediaSource(imgEl);
          if (typeof msg.mix === "number") {
            this.visualizer.mediaMix = msg.mix;
            const rangeMix = document.getElementById("rangeMediaMix");
            const valMix = document.getElementById("val_mediaMix");
            if (rangeMix) rangeMix.value = String(Math.round(msg.mix * 100));
            if (valMix) valMix.textContent = `${Math.round(msg.mix * 100)}%`;
          }
          if (typeof msg.mode === "number") {
            this.visualizer.mediaBlendMode = msg.mode;
            document.querySelectorAll("[data-media-mode]").forEach((c) => {
              c.classList.toggle("active", Number(c.dataset.mediaMode) === msg.mode);
            });
          }
        };
        imgEl.src = msg.dataUrl;
        if (btnUpload) btnUpload.classList.add("active");
      }
    } else if (msg.type === "mediaClear") {
      const imgEl = document.getElementById("customImageEl");
      const videoEl = document.getElementById("customVideoEl");
      if (imgEl) imgEl.src = "";
      if (videoEl) {
        videoEl.pause();
        videoEl.src = "";
      }
      this.visualizer.clearMediaSource();
      const btnUpload = document.getElementById("btnUploadMedia");
      const btnCamera = document.getElementById("btnLiveCamera");
      if (btnUpload) btnUpload.classList.remove("active");
      if (btnCamera) btnCamera.classList.remove("active");
      const rangeMix = document.getElementById("rangeMediaMix");
      const valMix = document.getElementById("val_mediaMix");
      if (rangeMix) rangeMix.value = "0";
      if (valMix) valMix.textContent = "0%";
    } else if (msg.type === "installCustomEffect" && msg.effect) {
      this.installCustomEffect(msg.effect, true, true);
    } else if (msg.type === "mode") {
      this.visualizer.setMode(msg.mode);
      this.highlightModeButtons(msg.mode);
    } else if (msg.type === "xy") {
      this.visualizer.setXY(msg.x, msg.y);
      this.updateXYUI(msg.x, msg.y);
    } else if (msg.type === "postFx") {
      this.applyPatchState(msg);
    } else if (msg.type === "fx") {
      if (msg.effect === "strobe") this.visualizer.fx.strobe = !!msg.active;
      if (msg.effect === "freeze") this.visualizer.fx.freeze = !!msg.active;
      if (msg.effect === "shockwave") this.visualizer.triggerShockwave();
      if (msg.effect === "colordrop") {
        this.visualizer.colorShift = msg.colorShift ?? (this.visualizer.colorShift + 0.27) % 1;
        this.visualizer.triggerShockwave();
      }
    } else if (msg.type === "dspTelemetry") {
      // Приймаємо аудіо-телеметрію з пульта/ноутбука на Проектор та Split
      // Ігноруємо тільки якщо на проекторі вручну запущено локальний мікрофон або аудіофайл
      const hasLocalMicrophoneOrFile =
        this.audioStarted &&
        (this.dsp.activeSource === "mic" || this.dsp.activeSource === "file");

      if (this.currentView !== "remote" && !hasLocalMicrophoneOrFile) {
        this.audioStarted = false;
        this.dsp.ingestRemoteTelemetry(msg.state);
      }
    }
  }

  setupPeerSyncHeartbeat() {
    this.lastPeerHeartbeat = null;
    // Миттєвий анонс присутності при старті
    setTimeout(() => {
      this.sync.send({
        type: "peerHeartbeat",
        role: this.currentView,
        isPing: true,
        hudCollapsed: this.projectorHudCollapsed,
      });
    }, 250);

    setInterval(() => {
      this.sync.send({
        type: "peerHeartbeat",
        role: this.currentView,
        isPing: true,
        hudCollapsed: this.projectorHudCollapsed,
      });
      if (
        this.lastPeerHeartbeat &&
        performance.now() - this.lastPeerHeartbeat > 16000
      ) {
        this.updatePeerStatusUI(false);
      }
    }, 2500);
  }

  updatePeerStatusUI(isLinked, role = null) {
    const badge = document.getElementById("btnRoomBadge");
    const text = document.getElementById("roomCodeText");
    if (!badge || !text) return;

    const isConnected = !!this.sync.connected;

    badge.classList.toggle("online", isConnected);

    if (isLinked) {
      badge.classList.add("peer-linked");
      badge.classList.add("p2p-active");
      badge.title = `Кімната ${this.sync.roomId}: Синхронізовано з ${role === "remote" ? "Пультом" : "Проектором"} через Wi-Fi (${this.sync.serverHost})!`;
      text.textContent = `${this.sync.roomId} ⚡ LAN`;
    } else {
      badge.classList.remove("peer-linked");
      badge.classList.remove("p2p-active");
      if (isConnected) {
        badge.title = `Сервер активний (${this.sync.serverHost}). Натисніть для QR-коду або відкрийте ${this.sync.serverHost} на телефоні/ноутбуці`;
        const hostDisplay = this.sync.serverHost && this.sync.serverHost !== "localhost:3456" ? this.sync.serverHost : this.sync.roomId;
        text.textContent = (this.currentView === "projector" || window.innerWidth > 680)
          ? `${hostDisplay} 🟡 LAN`
          : `${this.sync.roomId} 🟡 LAN`;
      } else {
        badge.title = `Підключення до локального сервера ${this.sync.serverHost}...`;
        text.textContent = `${this.sync.roomId} ⏳ LAN`;
      }
    }
  }

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));

    let dspState;
    const hasLiveRemote =
      this.dsp.activeSource === "remote" &&
      this.dsp.lastRemoteTelemetryTime &&
      now - this.dsp.lastRemoteTelemetryTime < 1500;

    if (this.audioStarted || hasLiveRemote) {
      dspState = this.dsp.update(now);
    } else {
      dspState = this.dsp.getAutonomousState(now);
    }

    // Якщо це Пульт (або Split з активним власним джерелом звуку) — транслюємо телеметрію + фазу часу на Проектор
    const shouldBroadcastTelemetry =
      this.currentView === "remote" ||
      (this.currentView === "split" &&
        this.audioStarted &&
        this.dsp.activeSource !== "remote");

    if (shouldBroadcastTelemetry) {
      this.sync.send({
        type: "dspTelemetry",
        state: [
          Math.round(dspState.subBass * 100) / 100,
          Math.round(dspState.bass * 100) / 100,
          Math.round(dspState.mid * 100) / 100,
          Math.round(dspState.high * 100) / 100,
          Math.round(dspState.beatIntensity * 100) / 100,
          dspState.bpm || 128,
          Math.round(dspState.beatPhase * 100) / 100,
          dspState.isBeat ? 1 : 0,
          dspState.beatCount || 0,
          Math.round(this.visualizer.accumulatedTime * 100) / 100,
        ],
      });
    } else if (hasLiveRemote && typeof dspState.remoteTime === "number") {
      // Підтягуємо внутрішній час шейдерів проектора до часу пульта ТІЛЬКИ якщо віддалений час просувається вперед!
      if (
        this.lastReceivedRemoteTime !== undefined &&
        dspState.remoteTime > this.lastReceivedRemoteTime
      ) {
        const timeDiff = dspState.remoteTime - this.visualizer.accumulatedTime;
        if (Math.abs(timeDiff) > 1.2) {
          this.visualizer.accumulatedTime = dspState.remoteTime;
        } else if (Math.abs(timeDiff) > 0.05) {
          this.visualizer.accumulatedTime += timeDiff * 0.22;
        }
      }
      this.lastReceivedRemoteTime = dspState.remoteTime;
    } else {
      this.lastReceivedRemoteTime = undefined;
    }

    this.visualizer.render(dspState, now);

    // Оновлюємо пульсацію активного мікрофона на пульті
    if (this.micLiveDotEl) {
      this.micLiveDotEl.classList.toggle(
        "live",
        this.audioStarted &&
          (this.dsp.activeSource === "mic" || this.dsp.activeSource === "screen")
      );
    }

    // Оновлюємо індикатори Audio-CHOP матриці
    for (const [key, val] of Object.entries(this.visualizer.effectivePostFx)) {
      const bar = this.chopBarEls[key];
      if (bar) {
        bar.style.width = `${Math.round(val * 100)}%`;
      }
    }

    if (this.beatLedEl) {
      this.beatLedEl.classList.toggle("beat-hit", dspState.beatIntensity > 0.55);
    }
    if (this.bpmDisplayEl) {
      this.bpmDisplayEl.textContent = `${dspState.bpm || 128} BPM`;
    }

    if (this.meterEls.sub) this.meterEls.sub.style.height = `${Math.max(10, dspState.subBass * 100)}%`;
    if (this.meterEls.bass) this.meterEls.bass.style.height = `${Math.max(10, dspState.bass * 100)}%`;
    if (this.meterEls.mid) this.meterEls.mid.style.height = `${Math.max(10, dspState.mid * 100)}%`;
    if (this.meterEls.high) this.meterEls.high.style.height = `${Math.max(10, dspState.high * 100)}%`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.auraApp = new AuraVJApp();
});
