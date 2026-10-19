/**
 * AURA FX LAB (studio.js) — Окремий конструктор ефектів у стилі TouchDesigner & Filmora
 * із прямою заливкою створених шейдерів і пресетів на Мобільний Пульт та в Android APK Проектора
 */
class AuraFXStudio {
  constructor() {
    this.dsp = new DSPEngine();
    this.previewCanvas = document.getElementById("studioPreviewCanvas");
    this.overlayCanvas = document.getElementById("studioOverlayCanvas");
    this.visualizer = new ShaderVisualizer(this.previewCanvas, this.overlayCanvas);
    this.sync = new SyncManager((msg) => this.handleSyncMessage(msg));

    this.activeTemplate = "voronoi";
    this.params = {
      scale: 0.5,
      audio: 0.75,
      glow: 0.65,
      palette: 0.2,
    };

    this.audioStarted = false;
    this.initNodeGraph();
    this.setupUI();
    this.generateAndCompileFromTemplate();

    requestAnimationFrame((t) => this.loop(t));
  }

  setupUI() {
    const roomPill = document.getElementById("studioRoomPill");
    if (roomPill) roomPill.textContent = `🔗 Кімната: ${this.sync.roomId}`;
    const backBtn = document.getElementById("btnBackToStage");
    if (backBtn) {
      backBtn.href = `index.html?room=${encodeURIComponent(this.sync.roomId)}`;
    }

    // Запуск звуку при першому кліку для живого прев'ю
    const unlock = () => {
      if (!this.audioStarted) {
        this.dsp.start("synth").catch(() => {});
        this.dsp.setSynthMute(true); // Тихий синтезатор за замовчуванням у конструкторі
        this.audioStarted = true;
      }
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });

    // Вибір базового генератора (TouchDesigner Generator TOP)
    const templateMeta = {
      voronoi: { emoji: "🧬", name: "TD Voronoi", sub: "Клітинний неон" },
      octahedron: { emoji: "💎", name: "3D Октаедр", sub: "Raymarch SDF" },
      matrix: { emoji: "🟢", name: "Cyber Wave", sub: "Матриця & Хвиля" },
      vortex: { emoji: "🌀", name: "Hypno Vortex", sub: "Лазерна спіраль" },
      tesla: { emoji: "⚡", name: "Tesla Plasma", sub: "Електро-дуги" },
      lasers_custom: { emoji: "🎆", name: "Laser Cross", sub: "Galvo Приціл" },
    };

    document.querySelectorAll(".tpl-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tpl-btn").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        this.activeTemplate = btn.dataset.tpl;
        const meta = templateMeta[this.activeTemplate];
        if (meta) {
          document.getElementById("effEmoji").value = meta.emoji;
          document.getElementById("effName").value = meta.name;
          document.getElementById("effSub").value = meta.sub;
          document.getElementById("activeNodeLabel").textContent = `TOP: ${meta.name}`;
        }
        this.generateAndCompileFromTemplate();
      });
    });

    // Слайдери параметрів генератора
    const bindParam = (id, key) => {
      const el = document.getElementById(id);
      const lbl = document.getElementById(`lbl_${id}`);
      if (!el) return;
      el.addEventListener("input", (e) => {
        const pct = Number(e.target.value);
        this.params[key] = pct / 100;
        if (lbl) lbl.textContent = `${pct}%`;
        this.generateAndCompileFromTemplate();
      });
    };
    bindParam("paramScale", "scale");
    bindParam("paramAudio", "audio");
    bindParam("paramGlow", "glow");
    bindParam("paramPalette", "palette");

    // Слайдери шарів Filmora Post-FX
    document.querySelectorAll(".studio-fx-range").forEach((slider) => {
      slider.addEventListener("input", (e) => {
        const fx = slider.dataset.fx;
        const pct = Number(e.target.value);
        this.visualizer.setPostFx(fx, pct / 100);
        const lbl = document.getElementById(`sval_${fx}`);
        if (lbl) lbl.textContent = `${pct}%`;
      });
    });

    // Початкові значення Filmora FX
    this.visualizer.setPostFx("rgbSplit", 0.25);
    this.visualizer.setPostFx("feedback", 0.2);

    const blobChk = document.getElementById("studioBlobHud");
    if (blobChk) {
      blobChk.addEventListener("change", (e) => {
        this.visualizer.blobHudEnabled = e.target.checked;
      });
    }

    // Ручна компіляція GLSL коду
    const btnCompile = document.getElementById("btnCompileGlsl");
    const editor = document.getElementById("glslEditor");
    if (btnCompile && editor) {
      btnCompile.addEventListener("click", () => {
        this.compileEditorCode(editor.value);
      });
    }

    // 🚀 ЗАЛИВКА НА ПУЛЬТ ТА В APK ПРОЕКТОРА
    document
      .getElementById("btnPushToRemoteAndApk")
      .addEventListener("click", () => this.pushEffectToRemoteAndApk());

    // Експорт / Імпорт .aurafx JSON
    document
      .getElementById("btnExportJson")
      .addEventListener("click", () => this.exportEffectFile());

    const importInput = document.getElementById("importFxInput");
    document.getElementById("btnImportJson").addEventListener("click", () => {
      importInput.click();
    });
    importInput.addEventListener("change", (e) => this.importEffectFile(e));
  }

  /**
   * Генерує GLSL-код сцени на основі обраного шаблону TouchDesigner та положення слайдерів
   */
  generateAndCompileFromTemplate() {
    const s = (0.4 + this.params.scale * 1.6).toFixed(2);
    const a = (0.2 + this.params.audio * 1.5).toFixed(2);
    const g = (0.3 + this.params.glow * 1.4).toFixed(2);
    const pShift = this.params.palette.toFixed(2);

    let glsl = "";

    if (this.activeTemplate === "voronoi") {
      glsl = `// TouchDesigner Voronoi Cellular Matrix TOP
vec3 col = vec3(0.0);
vec2 p = uv * (3.5 * ${s});
vec2 i_st = floor(p);
vec2 f_st = fract(p);
float m_dist = 1.0;
for (int y = -1; y <= 1; y++) {
  for (int x = -1; x <= 1; x++) {
    vec2 neighbor = vec2(float(x), float(y));
    float h = hash21(i_st + neighbor);
    vec2 point = 0.5 + 0.42 * sin(u_time * (1.2 + u_bass * ${a}) + 6.2831 * vec2(h, fract(h * 17.3)));
    float d = length(neighbor + point - f_st);
    m_dist = min(m_dist, d);
  }
}
float rings = abs(sin(m_dist * (10.0 + u_subBass * 8.0 * ${a}) - u_time * 2.5));
float glow = (0.025 * ${g}) / (rings + 0.015);
col = palette(m_dist + u_time * 0.15 + ${pShift}) * glow * (0.6 + u_subBass * 0.8);
return col;`;
    } else if (this.activeTemplate === "octahedron") {
      glsl = `// TouchDesigner 3D Raymarched Cyber Octahedron SOP
vec3 col = vec3(0.0);
vec2 p = uv * rot(u_time * 0.4 + u_beatCount * 0.25);
for (float i = 1.0; i <= 4.0; i += 1.0) {
  float rad = (0.16 * i * ${s}) * (1.0 + u_subBass * 0.45 * ${a});
  vec2 rp = p * rot(i * 0.45 + u_time * 0.3 * i);
  float oct = (abs(rp.x) + abs(rp.y)) - rad;
  float wire = (0.004 * ${g}) / (abs(oct) + 0.003);
  col += palette(i * 0.22 + u_time * 0.2 + ${pShift}) * wire * (0.45 + u_mid * 0.7);
}
return col;`;
    } else if (this.activeTemplate === "matrix") {
      glsl = `// Cyber Matrix Rain & Live Audio Oscilloscope
vec3 col = vec3(0.0);
vec2 grid = uv * vec2(18.0 * ${s}, 6.0);
float colId = floor(grid.x);
float dropSpeed = 1.5 + hash21(vec2(colId, 1.0)) * 2.5;
float rain = fract(grid.y + u_time * dropSpeed + hash21(vec2(colId, 2.0)));
float trail = smoothstep(0.85, 0.0, rain) * step(0.25, hash21(vec2(colId, floor(grid.y + u_time * 4.0))));
col += palette(colId * 0.05 + ${pShift}) * trail * (0.35 + u_high * ${a}) * ${g};

// Центральна осцилограма басу
float waveY = sin(uv.x * (8.0 * ${s}) + u_time * 6.0) * (0.15 + u_subBass * 0.38 * ${a});
float waveGlow = (0.008 * ${g}) / (abs(uv.y - waveY) + 0.006);
col += palette(uv.x * 0.4 + u_time * 0.3 + ${pShift}) * waveGlow;
return col;`;
    } else if (this.activeTemplate === "vortex") {
      glsl = `// Hypnotic Laser Vortex Spiral
vec2 p = uv * rot(u_time * 0.5);
float r = length(p);
float a = atan(p.y, p.x);
float arms = floor(4.0 + 4.0 * ${s});
float spiral = sin(a * arms + r * (14.0 - u_subBass * 6.0 * ${a}) - u_time * 5.0);
float beam = (0.03 * ${g}) / (abs(spiral) + 0.025);
vec3 col = palette(r * 1.2 - u_time * 0.25 + ${pShift}) * beam * smoothstep(0.02, 0.2, r);
return col;`;
    } else if (this.activeTemplate === "tesla") {
      glsl = `// High-Voltage Tesla Plasma Arcs
vec3 col = vec3(0.0);
for (float i = 1.0; i <= 5.0; i += 1.0) {
  vec2 p = uv * rot(i * 0.628 + u_time * 0.2);
  float n = noise2D(vec2(p.x * (6.0 * ${s}) + u_time * 4.0, i * 3.0)) - 0.5;
  float arc = abs(p.y - n * (0.25 + u_bass * 0.45 * ${a}));
  float bolt = (0.0035 * ${g}) / (arc + 0.0025);
  col += palette(i * 0.18 + u_time * 0.3 + ${pShift}) * bolt * 0.45;
}
return col;`;
    } else {
      glsl = `// Galvo Laser Crosshair & Starburst
vec3 col = sceneLasers(uv * ${s});
vec2 gUv = uv * rot(u_time * 0.8);
float crossDist = min(abs(gUv.x), abs(gUv.y));
float crossGlow = (0.003 * ${g} * (0.4 + u_subBass * ${a})) / (crossDist + 0.004);
col += palette(u_time * 0.4 + ${pShift}) * crossGlow * 0.45;
return col;`;
    }

    const editor = document.getElementById("glslEditor");
    if (editor) editor.value = glsl;
    this.compileEditorCode(glsl);
  }

  compileEditorCode(glslCode) {
    const badge = document.getElementById("compileStatusBadge");
    const effectObj = this.buildCurrentEffectObject(glslCode);
    const ok = this.visualizer.registerCustomEffect(effectObj);
    if (ok && !this.visualizer.lastShaderError) {
      this.visualizer.setMode(effectObj.id);
      if (badge) {
        badge.textContent = "✅ GLSL Скомпільовано (60 FPS)";
        badge.style.color = "#00f5d4";
      }
    } else if (badge) {
      badge.textContent = "⚠️ Помилка синтаксису GLSL";
      badge.style.color = "#ff2a85";
    }
  }

  buildCurrentEffectObject(glslOverride = null) {
    const emoji = document.getElementById("effEmoji").value.trim() || "🧪";
    const name = document.getElementById("effName").value.trim() || "Custom FX";
    const sub = document.getElementById("effSub").value.trim() || "FX Lab";
    const glsl = glslOverride || document.getElementById("glslEditor").value;
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9а-яіїєґ]+/gi, "_")
      .slice(0, 16);

    return {
      id: `custom_${slug || "fx"}`,
      emoji,
      name,
      sub,
      glsl,
      postFx: { ...this.visualizer.postFx },
      chopRouting: { ...this.visualizer.chopRouting },
      blobHudEnabled: this.visualizer.blobHudEnabled,
    };
  }

  /**
   * Заливає створений ефект:
   * 1) У локальне сховище браузера/APK (щоб кнопка одразу була на пульті)
   * 2) Через хмарну кімнату SyncManager на підключений iPhone Пульт та в Android Проектор (APK)!
   */
  pushEffectToRemoteAndApk() {
    const effect = this.buildCurrentEffectObject();
    this.compileEditorCode(effect.glsl);

    try {
      const raw = localStorage.getItem("aura_vj_custom_effects");
      const list = raw ? JSON.parse(raw) : [];
      const idx = list.findIndex((item) => item.id === effect.id);
      if (idx !== -1) list[idx] = effect;
      else list.push(effect);
      localStorage.setItem("aura_vj_custom_effects", JSON.stringify(list));
    } catch {
      // ignore
    }

    this.sync.send({
      type: "installCustomEffect",
      effect,
    });

    const toast = document.getElementById("deployToast");
    if (toast) {
      toast.textContent = `✅ Ефект "${effect.emoji} ${effect.name}" залито на Пульт та в APK (Кімната ${this.sync.roomId})!`;
      setTimeout(() => {
        toast.textContent = "";
      }, 5000);
    }
  }

  exportEffectFile() {
    const effect = this.buildCurrentEffectObject();
    const blob = new Blob([JSON.stringify(effect, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${effect.id}.aurafx.json`;
    a.click();
  }

  importEffectFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const eff = JSON.parse(reader.result);
        if (eff.emoji) document.getElementById("effEmoji").value = eff.emoji;
        if (eff.name) document.getElementById("effName").value = eff.name;
        if (eff.sub) document.getElementById("effSub").value = eff.sub;
        if (eff.glsl) {
          document.getElementById("glslEditor").value = eff.glsl;
          this.compileEditorCode(eff.glsl);
        }
        this.pushEffectToRemoteAndApk();
      } catch (err) {
        alert(`Помилка читання файлу .aurafx: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  /**
   * Інтерактивний TouchDesigner Node Network Canvas (перетягування нодів + пульсуючі кабелі)
   */
  initNodeGraph() {
    this.nodeCanvas = document.getElementById("nodeGraphCanvas");
    if (!this.nodeCanvas) return;
    this.nodeCtx = this.nodeCanvas.getContext("2d");

    this.nodes = [
      { id: "chop", title: "AUDIO CHOP", sub: "SUB / BASS / MID", x: 0.14, y: 0.32, color: "#ff2a85" },
      { id: "lfo", title: "LFO & XY CHOP", sub: "128 BPM Phase", x: 0.14, y: 0.72, color: "#fee440" },
      { id: "gen", title: "GENERATOR TOP", sub: "GLSL Shader Core", x: 0.46, y: 0.5, color: "#00f5d4" },
      { id: "fx", title: "FILMORA FX TOP", sub: "RGB / Kaleido / CV", x: 0.73, y: 0.5, color: "#9b5de5" },
      { id: "out", title: "PROJECTOR APK", sub: "Live Cloud Out", x: 0.92, y: 0.5, color: "#00f5d4" },
    ];

    this.draggingNode = null;

    const getRelPos = (e) => {
      const r = this.nodeCanvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) / r.width,
        y: (e.clientY - r.top) / r.height,
      };
    };

    this.nodeCanvas.addEventListener("pointerdown", (e) => {
      const p = getRelPos(e);
      for (const n of this.nodes) {
        if (Math.hypot(p.x - n.x, p.y - n.y) < 0.11) {
          this.draggingNode = n;
          this.nodeCanvas.setPointerCapture(e.pointerId);
          break;
        }
      }
    });

    this.nodeCanvas.addEventListener("pointermove", (e) => {
      if (!this.draggingNode) return;
      const p = getRelPos(e);
      this.draggingNode.x = Math.max(0.08, Math.min(0.92, p.x));
      this.draggingNode.y = Math.max(0.16, Math.min(0.86, p.y));
    });

    const stop = () => {
      this.draggingNode = null;
    };
    this.nodeCanvas.addEventListener("pointerup", stop);
    this.nodeCanvas.addEventListener("pointercancel", stop);
  }

  renderNodeGraph(dspState, now) {
    if (!this.nodeCanvas || !this.nodeCtx) return;
    const rect = this.nodeCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (
      this.nodeCanvas.width !== Math.round(rect.width * dpr) ||
      this.nodeCanvas.height !== Math.round(rect.height * dpr)
    ) {
      this.nodeCanvas.width = Math.round(rect.width * dpr);
      this.nodeCanvas.height = Math.round(rect.height * dpr);
    }

    const ctx = this.nodeCtx;
    const w = this.nodeCanvas.width;
    const h = this.nodeCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const links = [
      [0, 2],
      [1, 2],
      [2, 3],
      [3, 4],
    ];

    // Кабелі зв'язку TouchDesigner
    links.forEach(([fromIdx, toIdx]) => {
      const a = this.nodes[fromIdx];
      const b = this.nodes[toIdx];
      const x1 = a.x * w;
      const y1 = a.y * h;
      const x2 = b.x * w;
      const y2 = b.y * h;

      ctx.strokeStyle = a.color;
      ctx.lineWidth = (2.2 + (dspState.subBass || 0) * 3.0) * (dpr * 0.7);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo((x1 + x2) * 0.5, y1, (x1 + x2) * 0.5, y2, x2, y2);
      ctx.stroke();

      // Імпульс сигналу вздовж кабелю
      const t = (now * 0.0012) % 1;
      const px = x1 + (x2 - x1) * t;
      const py = y1 + (y2 - y1) * t;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(px, py, 3.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    });

    // Блоки нодів
    const boxW = Math.max(82, w * 0.17);
    const boxH = Math.max(40, h * 0.22);
    const fontTitle = Math.max(9, Math.round(boxW * 0.1));
    const fontSub = Math.max(8, Math.round(boxW * 0.085));

    this.nodes.forEach((n) => {
      const cx = n.x * w;
      const cy = n.y * h;
      const x0 = cx - boxW * 0.5;
      const y0 = cy - boxH * 0.5;

      ctx.fillStyle = "rgba(14, 17, 29, 0.92)";
      ctx.strokeStyle = n.color;
      ctx.lineWidth = 1.8 * dpr;
      ctx.beginPath();
      ctx.roundRect(x0, y0, boxW, boxH, 8 * dpr);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = n.color;
      ctx.font = `800 ${fontTitle}px -apple-system, sans-serif`;
      ctx.fillText(n.title, x0 + 8 * dpr, y0 + boxH * 0.45);

      ctx.fillStyle = "#9ca3c7";
      ctx.font = `600 ${fontSub}px -apple-system, sans-serif`;
      ctx.fillText(n.sub, x0 + 8 * dpr, y0 + boxH * 0.78);
    });
  }

  handleSyncMessage(msg) {
    if (msg && msg.type === "syncStatus") {
      const pill = document.getElementById("studioRoomPill");
      if (pill) {
        pill.textContent = `🔗 Кімната: ${msg.roomId} ${msg.connected ? "🟢" : ""}`;
      }
    }
  }

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));

    const t = now / 1000;
    const beatPhase = (now % 468.75) / 468.75;
    const kick = Math.pow(Math.max(0, 1.0 - beatPhase * 3.2), 2.0);
    const dspState = this.audioStarted
      ? this.dsp.update(now)
      : {
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

    this.visualizer.render(dspState, now);
    this.renderNodeGraph(dspState, now);

    const led = document.getElementById("studioBeatLed");
    if (led) led.classList.toggle("beat-hit", dspState.beatIntensity > 0.55);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.auraStudio = new AuraFXStudio();
});
