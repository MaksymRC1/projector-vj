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
    this.userPresets = this.loadUserPresets();

    this.initUrlParams();
    this.setupUI();
    this.setupStudioTabs();
    this.setupFilmoraFX();
    this.setupTouchDesignerCHOP();
    this.setupMediaTop();
    this.setupXYPad();
    this.setupFXButtons();
    this.loadSavedCustomEffects();
    this.setupSpatialNavigation();
    this.setupAutoHideHud();

    // Запускаємо рендер-цикл одразу (навіть до першого кліку працює візуальне демо)
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  initUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    if (view && ["split", "projector", "remote"].includes(view)) {
      this.setView(view);
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
  }

  setView(viewName) {
    this.currentView = viewName;
    document.body.dataset.view = viewName;
    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.targetView === viewName);
    });
    if (viewName === "projector") {
      this.resetHudTimer();
    }
  }

  async ensureAudioStarted(source = "synth", file = null) {
    try {
      await this.dsp.start(source, file);
      this.audioStarted = true;
    } catch (err) {
      alert(`Увага: ${err.message}. Перемикаємо на вбудований Техно-Синтезатор.`);
      await this.dsp.start("synth");
      this.audioStarted = true;
      this.highlightSourceButton("synth");
    }
  }

  setupUI() {
    const roomTextEl = document.getElementById("roomCodeText");
    if (roomTextEl) roomTextEl.textContent = this.sync.roomId;

    if (window.AndroidAudioBridge) {
      this.ensureAudioStarted("native_android");
    }

    const unlockAudio = () => {
      if (!this.audioStarted) {
        this.ensureAudioStarted(this.dsp.activeSource);
      }
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });

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
      this.visualizer.setMode(mode);
      this.highlightModeButtons(mode);
      this.sync.send({ type: "mode", mode });
    };

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
    const btnJoinRoom = document.getElementById("btnJoinRoom");
    if (btnJoinRoom) {
      btnJoinRoom.addEventListener("click", () => {
        const val = document.getElementById("roomInput").value.trim();
        if (val) {
          this.sync.setRoomId(val);
          this.renderQrModal();
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
   * Вкладки студії: Сцени & XY / Filmora FX / TouchDesigner CHOP Ноди / Відео & Камера
   */
  setupStudioTabs() {
    const tabs = document.querySelectorAll(".studio-tab");
    const panels = document.querySelectorAll(".studio-panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const targetId = tab.dataset.tab;
        tabs.forEach((t) => t.classList.toggle("active", t === tab));
        panels.forEach((p) => p.classList.toggle("active", p.id === targetId));
      });
    });
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
      btn.textContent = `⭐ ${preset.name}`;
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

    const updateMixUI = (pct) => {
      this.visualizer.mediaMix = pct / 100;
      if (rangeMix) rangeMix.value = String(pct);
      if (valMix) valMix.textContent = `${pct}%`;
    };

    if (btnUpload && mediaInput) {
      btnUpload.addEventListener("click", () => mediaInput.click());
      mediaInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        this.stopCameraStream();
        const url = URL.createObjectURL(file);

        if (file.type.startsWith("video/")) {
          videoEl.srcObject = null;
          videoEl.src = url;
          videoEl.play().catch(() => {});
          this.visualizer.setMediaSource(videoEl);
        } else {
          imgEl.onload = () => {
            this.visualizer.setMediaSource(imgEl);
          };
          imgEl.src = url;
        }
        btnUpload.classList.add("active");
        btnCamera.classList.remove("active");
        updateMixUI(80);
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
        this.visualizer.clearMediaSource();
        if (btnUpload) btnUpload.classList.remove("active");
        if (btnCamera) btnCamera.classList.remove("active");
        updateMixUI(0);
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
    let isDragging = false;

    const updateFromEvent = (e) => {
      const rect = pad.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, 1.0 - (e.clientY - rect.top) / rect.height));
      this.updateXYUI(x, y);
      this.visualizer.setXY(x, y);
      this.sync.send({ type: "xy", x, y });
    };

    pad.addEventListener("pointerdown", (e) => {
      isDragging = true;
      pad.setPointerCapture(e.pointerId);
      updateFromEvent(e);
    });

    pad.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      updateFromEvent(e);
    });

    const stopDrag = () => {
      isDragging = false;
    };
    pad.addEventListener("pointerup", stopDrag);
    pad.addEventListener("pointercancel", stopDrag);
  }

  updateXYUI(x, y) {
    const puck = document.getElementById("xyPuck");
    if (puck) {
      puck.style.left = `${x * 100}%`;
      puck.style.top = `${(1 - y) * 100}%`;
    }
  }

  setupFXButtons() {
    const btnStrobe = document.getElementById("fxStrobe");
    const btnShockwave = document.getElementById("fxShockwave");
    const btnFreeze = document.getElementById("fxFreeze");
    const btnColorDrop = document.getElementById("fxColorDrop");

    const setStrobe = (active) => {
      this.visualizer.fx.strobe = active;
      btnStrobe.classList.toggle("active", active);
      this.sync.send({ type: "fx", effect: "strobe", active });
    };
    btnStrobe.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      setStrobe(true);
    });
    btnStrobe.addEventListener("pointerup", () => setStrobe(false));
    btnStrobe.addEventListener("pointerleave", () => setStrobe(false));
    btnStrobe.addEventListener("pointercancel", () => setStrobe(false));

    const setFreeze = (active) => {
      this.visualizer.fx.freeze = active;
      btnFreeze.classList.toggle("active", active);
      this.sync.send({ type: "fx", effect: "freeze", active });
    };
    btnFreeze.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      setFreeze(true);
    });
    btnFreeze.addEventListener("pointerup", () => setFreeze(false));
    btnFreeze.addEventListener("pointerleave", () => setFreeze(false));
    btnFreeze.addEventListener("pointercancel", () => setFreeze(false));

    btnShockwave.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.visualizer.triggerShockwave();
      this.sync.send({ type: "fx", effect: "shockwave" });
    });

    btnColorDrop.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.visualizer.triggerColorDrop();
      this.sync.send({
        type: "fx",
        effect: "colordrop",
        colorShift: this.visualizer.colorShift,
      });
    });
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
        if (!candidates.includes(current)) return;

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
      if (this.currentView === "projector") {
        this.resetHudTimer();
      }
    };
    window.addEventListener("pointermove", triggerActivity);
    window.addEventListener("pointerdown", triggerActivity);
    window.addEventListener("keydown", triggerActivity);
  }

  resetHudTimer() {
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

  renderQrModal() {
    const baseUrl =
      window.location.protocol === "file:"
        ? "https://maksymrc1.github.io/projector-vj/"
        : `${window.location.origin}${window.location.pathname}`;
    const remoteUrl = `${baseUrl}?view=remote&room=${encodeURIComponent(this.sync.roomId)}`;
    document.getElementById("remoteUrlText").textContent = remoteUrl;
    const roomInput = document.getElementById("roomInput");
    if (roomInput) roomInput.value = this.sync.roomId;
    const qrBox = document.getElementById("qrCodeBox");
    const encoded = encodeURIComponent(remoteUrl);
    qrBox.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}" alt="QR Code для підключення смартфона" />`;
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
        <span class="pad-emoji">${effect.emoji || "🧪"}</span>
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
        <span class="dock-icon">${effect.emoji || "🧪"}</span>
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
      const text = document.getElementById("roomCodeText");
      const studioBtn = document.getElementById("btnOpenStudio");
      if (text && msg.roomId) text.textContent = msg.roomId;
      if (badge) badge.classList.toggle("online", !!msg.connected);
      if (studioBtn && msg.roomId) {
        studioBtn.href = `studio.html?room=${encodeURIComponent(msg.roomId)}`;
      }
      return;
    }
    if (msg.type === "installCustomEffect" && msg.effect) {
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
      if (
        this.currentView === "projector" &&
        this.dsp.activeSource !== "native_android"
      ) {
        this.dsp.activeSource = "remote";
        this.dsp.ingestRemoteTelemetry(msg.state);
      }
    }
  }

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));

    let dspState;
    if (this.audioStarted) {
      dspState = this.dsp.update(now);
    } else {
      const t = now / 1000;
      const beatPhase = (now % 468.75) / 468.75;
      const kick = Math.pow(Math.max(0, 1.0 - beatPhase * 3.2), 2.0);
      dspState = {
        subBass: 0.25 + kick * 0.72,
        bass: 0.3 + Math.sin(t * 3.0) * 0.25 + kick * 0.3,
        mid: 0.35 + Math.sin(t * 5.2) * 0.28,
        high: 0.25 + Math.abs(Math.sin(t * 11.0)) * 0.45,
        energy: 0.5,
        isBeat: beatPhase < 0.08,
        beatIntensity: kick,
        beatCount: Math.floor(now / 468.75),
        bpm: 128,
        beatPhase,
      };
    }

    if (this.currentView === "remote" && this.audioStarted) {
      this.sync.send({
        type: "dspTelemetry",
        state: {
          subBass: dspState.subBass,
          bass: dspState.bass,
          mid: dspState.mid,
          high: dspState.high,
          isBeat: dspState.isBeat,
          beatIntensity: dspState.beatIntensity,
          beatCount: dspState.beatCount,
          bpm: dspState.bpm,
          beatPhase: dspState.beatPhase,
        },
      });
    }

    this.visualizer.render(dspState, now);

    // Оновлюємо індикатори Audio-CHOP матриці
    for (const [key, val] of Object.entries(this.visualizer.effectivePostFx)) {
      const bar = document.getElementById(`chopBar_${key}`);
      if (bar) {
        bar.style.width = `${Math.round(val * 100)}%`;
      }
    }

    const beatLed = document.getElementById("beatLed");
    if (beatLed) {
      beatLed.classList.toggle("beat-hit", dspState.beatIntensity > 0.55);
    }
    const bpmEl = document.getElementById("bpmDisplay");
    if (bpmEl) {
      bpmEl.textContent = `${dspState.bpm || 128} BPM`;
    }

    document.getElementById("meterSub").style.height = `${Math.max(10, dspState.subBass * 100)}%`;
    document.getElementById("meterBass").style.height = `${Math.max(10, dspState.bass * 100)}%`;
    document.getElementById("meterMid").style.height = `${Math.max(10, dspState.mid * 100)}%`;
    document.getElementById("meterHigh").style.height = `${Math.max(10, dspState.high * 100)}%`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.auraApp = new AuraVJApp();
});
