/**
 * Головний контролер AURA VJ (Проектор + Смартфон Пульт + D-Pad Spatial Navigation)
 */
class AuraVJApp {
  constructor() {
    this.dsp = new DSPEngine();
    this.canvas = document.getElementById("shaderCanvas");
    this.visualizer = new ShaderVisualizer(this.canvas);
    this.sync = new SyncManager((msg) => this.handleSyncMessage(msg));

    this.currentView = "split"; // 'split' | 'projector' | 'remote'
    this.hudTimeout = null;
    this.audioStarted = false;

    this.initUrlParams();
    this.setupUI();
    this.setupXYPad();
    this.setupFXButtons();
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

    // Якщо це нативний Android APK на проекторі — запускаємо системне перехоплення звуку
    if (window.AndroidAudioBridge) {
      this.ensureAudioStarted("native_android");
    }

    // Автозапуск звуку при першому дотику користувача
    const unlockAudio = () => {
      if (!this.audioStarted) {
        this.ensureAudioStarted(this.dsp.activeSource);
      }
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });

    // Перемикач режимів екрана (Split / Проектор / Пульт)
    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.setView(btn.dataset.targetView));
    });

    // Вибір джерела звуку
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

    // Чекбокс звуку синтезатора
    const chkSynth = document.getElementById("chkSynthAudio");
    chkSynth.addEventListener("change", (e) => {
      this.dsp.setSynthMute(!e.target.checked);
    });

    // Перемикання візуальних сцен (і на пульті, і в доці проектора)
    const selectMode = (mode) => {
      this.visualizer.setMode(mode);
      this.highlightModeButtons(mode);
      this.sync.send({ type: "mode", mode });
    };

    document.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => selectMode(btn.dataset.mode));
    });

    // QR-код, Код Кімнати та Повний екран
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
    const puck = document.getElementById("xyPuck");
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

    // STROBE (поки утримується)
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

    // FREEZE (поки утримується)
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

    // SHOCKWAVE (миттєвий вибух)
    btnShockwave.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.visualizer.triggerShockwave();
      this.sync.send({ type: "fx", effect: "shockwave" });
    });

    // COLOR DROP (миттєва зміна неонової палітри)
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

        // 1. Edge-based direction filter
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
          // Не блокуємо preventDefault(), якщо кандидата в цьому напрямку немає
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
            ? (rect.top + rect.bottom) / 2
            : (rect.left + rect.right) / 2;
          const perpOffset = Math.abs(candCenterPerp - currCenterPerp);

          return { el, gap, overlapsPerp, perpOffset };
        });

        // 2. Спочатку кандидати з перетином по перпендикулярній осі, інакше зважений fallback
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

  handleSyncMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "syncStatus") {
      const badge = document.getElementById("btnRoomBadge");
      const text = document.getElementById("roomCodeText");
      if (text && msg.roomId) text.textContent = msg.roomId;
      if (badge) badge.classList.toggle("online", !!msg.connected);
      return;
    }
    if (msg.type === "mode") {
      this.visualizer.setMode(msg.mode);
      this.highlightModeButtons(msg.mode);
    } else if (msg.type === "xy") {
      this.visualizer.setXY(msg.x, msg.y);
      this.updateXYUI(msg.x, msg.y);
    } else if (msg.type === "fx") {
      if (msg.effect === "strobe") this.visualizer.fx.strobe = !!msg.active;
      if (msg.effect === "freeze") this.visualizer.fx.freeze = !!msg.active;
      if (msg.effect === "shockwave") this.visualizer.triggerShockwave();
      if (msg.effect === "colordrop") {
        this.visualizer.colorShift = msg.colorShift ?? (this.visualizer.colorShift + 0.27) % 1;
        this.visualizer.triggerShockwave();
      }
    } else if (msg.type === "dspTelemetry") {
      // Якщо проектор не перехоплює системний звук Android APK — приймає спектр з iPhone
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
      // Автономний демо-ритм до першого кліку
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

    // Якщо смартфон відкритий як пульт — транслюємо спектр його мікрофона на проектор
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

    // Оновлюємо WebGL шейдер
    this.visualizer.render(dspState, now);

    // Оновлюємо індикатори BPM та 4 частотних смуг
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
