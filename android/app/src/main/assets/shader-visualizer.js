/**
 * GPU WebGL Fragment Shader Visualizer Engine + TouchDesigner & Filmora FX Studio
 * Підтримує:
 * - 9 генеративних шейдерних сцен у 60 FPS (включно з TouchDesigner Blob Track, 3D Point Cloud, Reaction-Diffusion)
 * - 6 шарових пост-ефектів у стилі Filmora / TouchDesigner TOPs (RGB Split, Glitch/VHS, Kaleidoscope, Neon Edges, Feedback Warp, LED Pixelate)
 * - Audio-CHOP Матрицю модуляції (прив'язка Sub-Bass, Bass, Mid, High, LFO до будь-якого FX)
 * - WebGL Відео / Фото / Live Камера текстурний мікшер (Media TOP)
 * - TouchDesigner Computer Vision Blob Tracking HUD (неонова розмітка об'єктів з координатами та зв'язками)
 */
class ShaderVisualizer {
  constructor(canvas, overlayCanvas = null) {
    this.canvas = canvas;
    this.overlayCanvas = overlayCanvas || document.getElementById("tdOverlayCanvas");
    this.overlayCtx = this.overlayCanvas ? this.overlayCanvas.getContext("2d") : null;

    const isMobileOrTv =
      /Android|TV|GoogleTV|SmartTV|CrKey|Tizen|webOS/i.test(navigator.userAgent) ||
      !!window.AndroidAudioBridge;

    this.gl =
      canvas.getContext("webgl", {
        alpha: false,
        antialias: !isMobileOrTv,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
        depth: false,
        stencil: false,
      }) || canvas.getContext("experimental-webgl");

    this.modeIndex = 0;
    this.modes = [
      "lasers",      // 0: SCN-01 Galvo Laser & Nebula
      "blobtrack",   // 1: SCN-02 TouchDesigner Blob Track & Metaballs
      "pointcloud",  // 2: SCN-03 TouchDesigner 3D Point Cloud & Plexus
      "reaction",    // 3: SCN-04 TouchDesigner Reaction-Diffusion & Feedback
      "synthwave",   // 4: SCN-05 3D Synthwave Grid & Terrain
      "ferrofluid",  // 5: SCN-06 3D Ferrofluid Plasma Sphere
      "tunnel",      // 6: SCN-07 Cyber Infinity Tunnel
      "liquid",      // 7: SCN-08 Silk Fluid Aura
      "fractal",     // 8: SCN-09 Sacred Mandala Fractal
    ];

    this.xy = { x: 0.5, y: 0.5 };
    this.colorShift = 0.0;
    this.trueBlackProjectorMask = true;

    // Миттєві Live DJ тригери
    this.fx = {
      strobe: false,
      shockwave: 0.0,
      freeze: false,
    };

    // Конструктор пост-ефектів (Filmora / TouchDesigner TOP Stack) — базові значення 0..1
    this.postFx = {
      rgbSplit: 0.0,   // Chromatic Aberration
      glitch: 0.0,     // VHS / Slice Glitch
      kaleido: 0.0,    // Mirror Kaleidoscope
      edges: 0.0,      // Neon Find Edges
      feedback: 0.0,   // Curl Displace / Feedback Warp
      pixelate: 0.0,   // LED Matrix / Mosaic
    };

    // Audio-CHOP Матриця модуляції (TouchDesigner CHOP Export):
    // Значення: 'none' | 'subBass' | 'bass' | 'mid' | 'high' | 'lfo'
    this.chopRouting = {
      rgbSplit: "subBass",
      glitch: "none",
      kaleido: "none",
      edges: "none",
      feedback: "bass",
      pixelate: "none",
    };

    // Поточні зريалізовані (після CHOP-модуляції) значення ефектів для індикаторів UI
    this.effectivePostFx = { ...this.postFx };

    // TouchDesigner Computer Vision Blob Tracking HUD (поверх будь-якої сцени або відео)
    this.blobHudEnabled = false;
    this.trackedBlobs = [];

    // Медіа-текстура (Відео / Фото / Жива Камера)
    this.mediaMix = 0.0; // 0..1
    this.mediaBlendMode = 0; // 0: Add/Screen, 1: Audio Displace, 2: Neon Cyberpunk Edges
    this.mediaElement = null;
    this.hasMedia = false;

    // Динамічні користувацькі шейдери зі Студії Генерації (studio.html)
    this.customSceneGlsl = "return sceneLasers(uv);";
    this.customEffects = {};

    // Комерційний PRO-статус, B2B-брендинг закладу та Keystone-маска проектора
    this.isPro = false;
    this.roomId = "----";
    this.venueOverlay = {
      enabled: false,
      title: "",
      subtitle: "",
    };
    this.keystone = {
      scale: 1.0, // 0.5 .. 1.0
      cropX: 0.0, // 0.0 .. 0.35
      cropY: 0.0, // 0.0 .. 0.35
    };

    // Auto-FPS Optimizer для бюджетних проекторів (Magcubic HY300 / Mali-G31)
    this.renderScale = isMobileOrTv ? 0.75 : 1.0;
    this.rawViewportWidth = isMobileOrTv ? 1280 : 1920;
    this.rawViewportHeight = isMobileOrTv ? 720 : 1080;
    this.fpsFrames = 0;
    this.fpsLastCheck = performance.now();
    this.currentFps = 60;

    this.accumulatedTime = 0;
    this.lastTimestamp = performance.now();

    this.initWebGL(this.customSceneGlsl);
    this.initTrackedBlobs();
    this.setupResizeObserver();
  }

  initTrackedBlobs() {
    this.trackedBlobs = Array.from({ length: 7 }, (_, i) => ({
      id: `TD_${(i + 1).toString().padStart(2, "0")}`,
      x: 0.2 + (i * 0.11) % 0.6,
      y: 0.25 + ((i * 0.17) % 0.5),
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      size: 42 + (i % 3) * 24,
      band: ["subBass", "bass", "mid", "high"][i % 4],
    }));
  }

  applyCanvasResolution() {
    const w = Math.max(320, Math.round(this.rawViewportWidth * this.renderScale));
    const h = Math.max(180, Math.round(this.rawViewportHeight * this.renderScale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.gl) {
        this.gl.viewport(0, 0, w, h);
      }
    }
    if (this.overlayCanvas) {
      if (
        this.overlayCanvas.width !== this.rawViewportWidth ||
        this.overlayCanvas.height !== this.rawViewportHeight
      ) {
        this.overlayCanvas.width = this.rawViewportWidth;
        this.overlayCanvas.height = this.rawViewportHeight;
      }
    }
  }

  setupResizeObserver() {
    const observer = new ResizeObserver(([entry]) => {
      const isMobileOrTv =
        /Android|TV|GoogleTV|SmartTV|CrKey|Tizen|webOS/i.test(navigator.userAgent) ||
        !!window.AndroidAudioBridge;

      // Для проекторів і ТВ обмежуємо DPR строго 1.0 (замість 2.0-3.0), щоб усунути навантаження 4K на Mali-G31
      const maxDpr = isMobileOrTv ? 1.0 : Math.min(window.devicePixelRatio || 1, 1.25);
      const w = Math.round(entry.contentRect.width * maxDpr);
      const h = Math.round(entry.contentRect.height * maxDpr);

      // На проекторах обмежуємо базову роздільну здатність максимум 1280x720 (720p)
      const maxW = isMobileOrTv ? 1280 : 1920;
      const maxH = isMobileOrTv ? 720 : 1080;
      this.rawViewportWidth = Math.max(320, Math.min(maxW, w));
      this.rawViewportHeight = Math.max(180, Math.min(maxH, h));
      this.applyCanvasResolution();
    });

    const supportsDevicePixelContentBox =
      typeof ResizeObserverEntry !== "undefined" &&
      "devicePixelContentBoxSize" in ResizeObserverEntry.prototype;
    const options = supportsDevicePixelContentBox
      ? { box: "device-pixel-content-box" }
      : {};
    try {
      observer.observe(this.canvas, options);
    } catch {
      observer.observe(this.canvas);
    }
  }

  initWebGL(customGlsl = this.customSceneGlsl) {
    const gl = this.gl;
    if (!gl) return;

    const vsSource = `
      attribute vec2 a_position;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fsSource = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
        precision mediump float;
        precision highp int;
      #else
        precision mediump float;
        precision mediump int;
      #endif

      uniform highp vec2 u_resolution;
      uniform highp float u_time;
      uniform int u_mode;
      uniform float u_subBass;
      uniform float u_bass;
      uniform float u_mid;
      uniform float u_high;
      uniform float u_beatIntensity;
      uniform float u_beatPhase;
      uniform float u_beatCount;
      uniform vec2 u_xy;
      uniform float u_colorShift;
      uniform float u_strobe;
      uniform float u_shockwave;
      uniform float u_projectorMask;

      // Filmora & TouchDesigner Post-FX Stack
      uniform float u_fxRgbSplit;
      uniform float u_fxGlitch;
      uniform float u_fxKaleido;
      uniform float u_fxEdges;
      uniform float u_fxFeedback;
      uniform float u_fxPixelate;

      // Media / Camera TOP Mixer
      uniform sampler2D u_mediaTex;
      uniform float u_mediaMix;
      uniform int u_mediaMode;

      #define PI 3.14159265359

      mat2 rot(float a) {
        float s = sin(a), c = cos(a);
        return mat2(c, -s, s, c);
      }

      vec3 palette(float t) {
        vec3 a = vec3(0.5, 0.5, 0.5);
        vec3 b = vec3(0.5, 0.5, 0.5);
        vec3 c = vec3(1.0, 1.0, 1.0);
        vec3 d = vec3(0.00, 0.33, 0.67) + u_colorShift;
        return a + b * cos(6.28318 * (c * t + d));
      }

      float hash21(vec2 p) {
        p = fract(p * vec2(234.34, 435.345));
        p += dot(p, p + 34.23);
        return fract(p.x * p.y);
      }

      float noise2D(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      float sdSegment(vec2 p, vec2 a, vec2 b) {
        vec2 pa = p - a, ba = b - a;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - ba * h);
      }

      float sdHexagon(vec2 p, float r) {
        vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
        p = abs(p);
        p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
        p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
        return length(p) * sign(p.y);
      }

      float sdEquilateralTriangle(vec2 p, float r) {
        float k = sqrt(3.0);
        p.x = abs(p.x) - r;
        p.y = p.y + r / k;
        if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
        p.x -= clamp(p.x, -2.0 * r, 0.0);
        return -length(p) * sign(p.y);
      }

      float smin(float a, float b, float k) {
        float h = max(k - abs(a - b), 0.0) / k;
        return min(a, b) - h * h * k * (1.0 / 4.0);
      }

      float mapFerrofluid(vec3 p) {
        vec3 center = vec3(0.0, 0.05, 0.0);
        vec3 q = p - center;
        float r = length(q);
        vec3 nq = q / max(r, 0.001);
        float spikeFreq = 8.0 + u_xy.x * 4.0;
        float s1 = sin(nq.x * spikeFreq) * cos(nq.y * spikeFreq) * sin(nq.z * spikeFreq);
        float s2 = sin(nq.x * (spikeFreq * 1.8) + u_time * 2.0) * cos(nq.z * (spikeFreq * 1.8));
        float spikes = pow(max(0.0, s1 * 0.7 + s2 * 0.4), 2.5) * (0.35 + u_bass * 0.55 + u_beatIntensity * 0.25);
        float sphere = r - (0.52 + u_subBass * 0.14) - spikes;

        float ripple = sin(length(p.xz) * 14.0 - u_time * 4.0) * (0.02 + u_subBass * 0.035) * exp(-length(p.xz) * 0.8);
        float plane = p.y + 0.65 - ripple;
        return smin(sphere, plane, 0.22);
      }

      vec3 calcFerroNormal(vec3 p) {
        vec2 e = vec2(0.005, 0.0);
        return normalize(vec3(
          mapFerrofluid(p + e.xyy) - mapFerrofluid(p - e.xyy),
          mapFerrofluid(p + e.yxy) - mapFerrofluid(p - e.yxy),
          mapFerrofluid(p + e.yyx) - mapFerrofluid(p - e.yyx)
        ));
      }

      // 0: LASER MATRIX & VOLUMETRIC BEAMS (CONCERT HAZE & MULTI-POD LASERS)
      vec3 sceneLasers(vec2 uv) {
        vec3 col = vec3(0.004, 0.008, 0.016);
        float spread = 0.55 + u_xy.x * 1.25;
        float speed = 0.75 + u_xy.y * 1.4;

        vec2 smokeUv = uv * 2.2 + vec2(u_time * 0.08, -u_time * 0.12);
        float smoke1 = noise2D(smokeUv);
        float smoke2 = noise2D(smokeUv * 2.1 - vec2(u_time * 0.15, u_time * 0.05));
        float haze = smoothstep(0.2, 0.85, smoke1 * 0.6 + smoke2 * 0.4);
        col += vec3(0.01, 0.04, 0.06) * haze * (0.8 + u_subBass * 0.6);

        vec2 pods[4];
        pods[0] = vec2(-0.82, 0.88);
        pods[1] = vec2(-0.28, 0.92);
        pods[2] = vec2(0.28, 0.92);
        pods[3] = vec2(0.82, 0.88);

        vec3 podColors[4];
        podColors[0] = vec3(0.0, 1.0, 0.35);
        podColors[1] = vec3(0.0, 0.88, 1.0);
        podColors[2] = vec3(0.0, 0.88, 1.0);
        podColors[3] = vec3(0.0, 1.0, 0.35);

        for (int p = 0; p < 4; p++) {
          float dPod = length(uv - pods[p]);
          float podGlow = 0.005 / (dPod * dPod + 0.0018);
          col += podColors[p] * podGlow * (0.4 + u_subBass * 0.5);
          col += vec3(1.0) * (0.0018 / (dPod + 0.0015));
        }

        for (int p = 0; p < 4; p++) {
          vec2 origin = pods[p];
          vec2 dirVec = uv - origin;
          vec3 podCol = podColors[p];
          float pSign = (p < 2) ? -1.0 : 1.0;

          for (float i = -3.0; i <= 3.0; i += 1.0) {
            float baseAngle = (pSign * 0.42) + i * 0.11 * spread;
            float scanOsc = sin(u_time * speed * 2.2 + i * 0.8 + float(p) * 1.5) * (0.16 + u_mid * 0.22);
            float angle = baseAngle + scanOsc;

            vec2 rayDir = normalize(vec2(sin(angle), -cos(angle)));
            float proj = max(0.0, dot(dirVec, rayDir));
            float perpDist = length(dirVec - rayDir * proj);

            float core = 0.0012 / (perpDist + 0.001);
            float beamHaze = (0.003 * (0.35 + haze * 1.3)) / (perpDist * perpDist + 0.002);
            float lengthFade = smoothstep(0.0, 0.12, proj) * smoothstep(2.4, 0.4, proj);

            vec3 beamLight = mix(podCol, vec3(1.0), 0.35) * core + podCol * beamHaze;
            col += beamLight * lengthFade * (0.35 + u_subBass * 0.45);
          }
        }

        for (float s = 0.0; s < 3.0; s += 1.0) {
          float sheetPhase = u_time * (speed * 0.75) + s * 1.8 + floor(u_beatCount) * 0.6;
          vec2 pTop = vec2(sin(sheetPhase * 0.7) * 0.32, 0.85);
          vec2 pBottomL = vec2(-0.75 + sin(sheetPhase) * 0.2, -0.65 + cos(sheetPhase * 1.2) * 0.15);
          vec2 pBottomR = vec2(0.75 + cos(sheetPhase) * 0.2, -0.65 + sin(sheetPhase * 1.1) * 0.15);

          float d1 = sdSegment(uv, pTop, pBottomL);
          float d2 = sdSegment(uv, pTop, pBottomR);
          float d3 = sdSegment(uv, pBottomL, pBottomR);
          float sheetEdge = min(min(d1, d2), d3);

          float edgeLine = (0.002 + u_subBass * 0.0025) / (sheetEdge + 0.0015);
          vec3 sheetCol = (s == 1.0) ? vec3(0.0, 0.95, 1.0) : vec3(0.0, 1.0, 0.4);
          col += sheetCol * edgeLine * 0.45;
        }

        return col;
      }

      // 1: 3D SYNTHWAVE AUDIO TERRAIN (RETRO SUN, CEILING & UNDULATING MOUNTAINS)
      vec3 sceneSynthwave(vec2 uv) {
        vec3 col = vec3(0.02, 0.01, 0.05);
        float horizon = -0.02 + (u_xy.y - 0.5) * 0.25;

        vec2 sunUv = uv - vec2(0.0, horizon + 0.38);
        float sunRadius = 0.32 + u_subBass * 0.08;
        float sunDist = length(sunUv);
        if (sunDist < sunRadius) {
          float normY = (sunUv.y + sunRadius) / (2.0 * sunRadius);
          float stripeFreq = 34.0;
          float stripeCut = mix(0.1, 0.65, 1.0 - normY);
          float stripe = fract(sunUv.y * stripeFreq - u_time * 0.08);
          if (stripe > stripeCut || normY > 0.72) {
            vec3 sunCol = mix(vec3(1.0, 0.05, 0.6), vec3(1.0, 0.88, 0.15), normY);
            col = sunCol;
          }
        }
        col += vec3(1.0, 0.1, 0.6) * (0.035 / (abs(sunDist - sunRadius) + 0.045)) * (0.7 + u_subBass * 0.8);

        if (uv.y > horizon + 0.15) {
          float zCeil = 1.0 / max(0.01, uv.y - horizon);
          float xCeil = uv.x * zCeil * 0.75;
          float gridX = abs(fract(xCeil) - 0.5);
          float gridZ = abs(fract(zCeil * 0.4 + u_time * (1.8 + u_subBass * 1.5)) - 0.5);
          float lineCeil = min(gridX, gridZ);
          float glowCeil = 0.014 / (lineCeil + 0.015);
          float fogCeil = exp(-zCeil * 0.09);
          vec3 ceilCol = vec3(0.55, 0.1, 0.95);
          col += ceilCol * glowCeil * fogCeil * 0.65;
        }

        if (uv.y < horizon) {
          float z = 1.0 / max(0.008, horizon - uv.y);
          float x = uv.x * z * (0.85 + u_xy.x * 0.6);

          float valley = smoothstep(0.8, 3.2, abs(x));
          float m1 = sin(x * 0.75) * cos(z * 0.35 - u_time * 3.0);
          float m2 = sin(x * 1.6 + z * 0.7) * cos(x * 0.9 - u_time * 2.0) * 0.5;
          float mountainHeight = valley * (m1 + m2) * (0.6 + u_bass * 0.9);

          float gridX = abs(fract(x + mountainHeight * 0.5) - 0.5);
          float gridZ = abs(fract(z * 0.45 - u_time * (2.4 + u_subBass * 2.8)) - 0.5);
          float line = min(gridX, gridZ);

          float glow = 0.022 / (line + 0.012);
          float fog = exp(-z * 0.065);

          vec3 gridCol = mix(vec3(1.0, 0.08, 0.75), vec3(0.0, 0.9, 1.0), sin(z * 0.1 - u_time * 0.5) * 0.5 + 0.5);
          vec3 mountainBody = vec3(0.06, 0.015, 0.12) * (1.0 - valley * 0.4);
          col = mountainBody + gridCol * glow * fog * (0.9 + u_mid * 0.7);
        }

        float horizGlow = 0.006 / (abs(uv.y - horizon) + 0.004);
        col += vec3(0.0, 0.95, 1.0) * horizGlow * (1.0 + u_beatIntensity * 1.2);

        return col;
      }

      // 2: 3D AUDIO FERROFLUID SPHERE (RAYMARCHED CHROME LIQUID & MAGNETIC SPIKES)
      vec3 sceneFerrofluid(vec2 uv) {
        vec3 col = vec3(0.01, 0.015, 0.03);
        vec2 p = uv;
        vec3 ro = vec3(0.0, 0.2, 2.1);
        vec3 rd = normalize(vec3(p.x, p.y - 0.08, -1.8));

        float rotY = (u_xy.x - 0.5) * 1.5 + u_time * 0.15;
        mat2 rY = rot(rotY);
        ro.xz = rY * ro.xz;
        rd.xz = rY * rd.xz;

        float t = 0.5;
        float hit = -1.0;
        for (int i = 0; i < 36; i++) {
          vec3 pos = ro + rd * t;
          float d = mapFerrofluid(pos);
          if (d < 0.003) {
            hit = t;
            break;
          }
          t += d * 0.75;
          if (t > 4.5) break;
        }

        if (hit > 0.0) {
          vec3 pos = ro + rd * hit;
          vec3 n = calcFerroNormal(pos);
          vec3 ref = reflect(rd, n);

          vec3 lightDir1 = normalize(vec3(0.8, 1.2, 0.9));
          vec3 lightDir2 = normalize(vec3(-1.0, 0.4, -0.6));
          
          float diff1 = max(0.0, dot(n, lightDir1));
          float diff2 = max(0.0, dot(n, lightDir2));
          float spec1 = pow(max(0.0, dot(ref, lightDir1)), 28.0);
          float spec2 = pow(max(0.0, dot(ref, lightDir2)), 20.0);
          float fresnel = pow(1.0 - max(0.0, dot(-rd, n)), 3.5);

          vec3 baseChrome = vec3(0.04, 0.04, 0.06);
          vec3 cyanLight = vec3(0.0, 0.85, 1.0) * (diff1 * 0.4 + spec1 * 1.8);
          vec3 magentaLight = vec3(1.0, 0.1, 0.75) * (diff2 * 0.35 + spec2 * 1.5);
          vec3 iridescence = palette(fresnel * 1.4 + pos.y * 0.6 + u_time * 0.15) * fresnel * 2.2;

          col = baseChrome + cyanLight + magentaLight + iridescence;

          if (pos.y < -0.55) {
            col *= 0.75;
            col += vec3(0.0, 0.7, 1.0) * (0.2 + u_subBass * 0.3) * fresnel;
          }
        }

        float distToCenter = length(uv - vec2(0.0, -0.05));
        float corona = 0.022 / (abs(distToCenter - 0.58) + 0.035);
        col += palette(atan(uv.y, uv.x) / (2.0 * PI) + u_time * 0.2) * corona * (0.4 + u_subBass * 0.6);

        return col;
      }

      // 3: CYBER INFINITY TUNNEL (CONCENTRIC NEON HEXAGONS, TRIANGLES & HYPERSPACE)
      vec3 sceneTunnel(vec2 uv) {
        vec3 col = vec3(0.005, 0.005, 0.015);
        vec2 p = uv - (u_xy - 0.5) * 0.35;
        float r = length(p);
        float a = atan(p.y, p.x);

        float rays1 = pow(sin(a * 24.0 + u_time * 1.5), 18.0);
        float rays2 = pow(cos(a * 40.0 - u_time * 2.8), 24.0);
        float streaks = (rays1 * 0.7 + rays2 * 0.5) * smoothstep(0.08, 0.95, r);
        vec3 streakCol = mix(vec3(0.0, 0.85, 1.0), vec3(1.0, 0.1, 0.7), sin(a * 3.0 + u_time) * 0.5 + 0.5);
        col += streakCol * streaks * (0.45 + u_high * 1.3);

        float tunnelSpeed = 1.2 + u_xy.y * 1.8 + u_subBass * 1.4;
        for (float i = 1.0; i <= 14.0; i += 1.0) {
          float gateProgress = fract((i / 14.0) - u_time * tunnelSpeed * 0.18);
          float scale = pow(gateProgress, 2.8) * 2.2;
          if (scale < 0.02) continue;

          vec2 polyP = p / scale;
          float gateRot = (i * 0.28) + u_time * 0.25 * (mod(i, 2.0) == 0.0 ? 1.0 : -1.0);
          polyP = rot(gateRot) * polyP;

          float dPoly;
          vec3 gateCol;
          if (mod(i, 2.0) < 0.5) {
            dPoly = abs(sdHexagon(polyP, 0.85)) * scale;
            gateCol = vec3(0.0, 0.95, 1.0);
          } else {
            dPoly = abs(sdEquilateralTriangle(polyP, 0.9)) * scale;
            gateCol = vec3(1.0, 0.08, 0.7);
          }

          float lineGlow = (0.0022 + u_beatIntensity * 0.0035) / (dPoly + 0.002);
          float depthFade = smoothstep(0.0, 0.25, gateProgress) * smoothstep(1.0, 0.65, gateProgress);
          col += gateCol * lineGlow * depthFade * 0.85;
          col += vec3(1.0) * (0.0006 / (dPoly + 0.001)) * depthFade * 0.5;
        }

        col *= smoothstep(0.02, 0.18, r);
        float coreGlow = 0.008 / (r * r + 0.004);
        col += vec3(0.3, 0.8, 1.0) * coreGlow * (0.3 + u_subBass * 0.8);

        return col;
      }

      // 4: LIQUID AURA & SILK WAVES
      vec3 sceneLiquid(vec2 uv) {
        vec3 col = vec3(0.0);
        vec2 p = uv * (1.8 + u_xy.x * 1.5);

        for (float i = 1.0; i <= 5.0; i++) {
          p.x += 0.35 / i * sin(i * 2.5 * p.y + u_time * (0.9 + u_xy.y) + u_bass * 2.0);
          p.y += 0.35 / i * cos(i * 2.0 * p.x + u_time * 0.7 + u_mid * 2.0);

          float wave = abs(sin(p.y * 2.0 + p.x * 0.8 + i));
          float ribbon = (0.022 + u_subBass * 0.03) / (wave + 0.025);
          col += palette(i * 0.18 + u_time * 0.12 + length(uv) * 0.3) * ribbon * 0.16;
        }
        return col;
      }

      // 5: SACRED KALEIDOSCOPE FRACTAL
      vec3 sceneFractal(vec2 uv) {
        vec2 uv0 = uv;
        vec3 finalColor = vec3(0.0);
        float iterations = 3.0 + floor(u_xy.x * 2.0);

        for (float i = 0.0; i < 4.0; i++) {
          if (i >= iterations) break;
          uv = fract(uv * (1.4 + u_xy.y * 0.6)) - 0.5;
          uv *= rot(u_time * 0.25 + i * 0.5 + u_bass * 0.3);

          float d = length(uv) * exp(-length(uv0));
          vec3 col = palette(length(uv0) + i * 0.4 + u_time * 0.3);

          d = sin(d * (7.0 + u_mid * 5.0) + u_time * 2.0) / 8.0;
          d = abs(d);
          d = pow(0.011 / max(0.001, d), 1.15);

          finalColor += col * d * (0.5 + u_subBass * 0.7);
        }
        return finalColor;
      }

      // 6: TOUCHDESIGNER METABALL BLOB TRACKING & TOPOLOGY CONTOURS
      vec3 sceneBlobTrack(vec2 uv) {
        vec3 col = vec3(0.0);
        float field = 0.0;
        vec3 weightedCol = vec3(0.0);

        for (float i = 0.0; i < 6.0; i += 1.0) {
          float t = u_time * (0.7 + u_xy.y * 0.9) + i * 1.3;
          vec2 center = vec2(
            sin(t * 1.1 + i * 0.8) * (0.48 + u_bass * 0.22),
            cos(t * 0.85 - i * 1.2) * (0.38 + u_mid * 0.18)
          );
          float radius = 0.09 + (mod(i, 2.0) < 0.5 ? u_subBass : u_high) * 0.08;
          float d = length(uv - center);
          float influence = (radius * radius) / (d * d + 0.004);
          field += influence;
          weightedCol += palette(i * 0.16 + u_time * 0.12) * influence;
        }

        weightedCol /= max(0.001, field);

        // Ізолінії топології TouchDesigner (Level TOP + Edge TOP)
        float isoRings = abs(fract(field * (1.5 + u_xy.x * 2.5)) - 0.5);
        float contour = (0.018 + u_subBass * 0.02) / (isoRings + 0.015);
        float coreMask = smoothstep(0.65, 1.3, field);

        col += weightedCol * contour * smoothstep(0.2, 2.5, field) * 0.55;
        col += weightedCol * coreMask * 0.35;

        // Тонка технічна координатна сітка TouchDesigner
        vec2 grid = abs(fract(uv * 8.0) - 0.5);
        float gridLine = smoothstep(0.02, 0.0, min(grid.x, grid.y));
        col += vec3(0.0, 0.95, 0.85) * gridLine * (0.08 + u_high * 0.18);

        return col;
      }

      // 7: TOUCHDESIGNER 3D CURL POINT CLOUD & PLEXUS NETWORK
      vec3 scenePointCloud(vec2 uv) {
        vec3 col = vec3(0.0);
        vec2 p = uv * rot(u_time * 0.12 * (u_xy.x + 0.4));

        for (float layer = 1.0; layer <= 3.0; layer += 1.0) {
          float scale = 5.0 + layer * 3.5 + u_xy.x * 4.0;
          vec2 gridUv = p * scale + vec2(u_time * 0.3 * layer, sin(u_time * 0.4) * layer);
          vec2 id = floor(gridUv);
          vec2 f = fract(gridUv) - 0.5;

          float h = hash21(id + layer * 19.0);
          vec2 offset = vec2(
            sin(u_time * (1.5 + u_xy.y) + h * 12.0),
            cos(u_time * (1.2 + u_xy.y) + h * 18.0)
          ) * (0.28 + u_bass * 0.18);

          float d = length(f - offset);
          float ptSize = (0.003 + u_subBass * 0.005) / (d * d + 0.0012);

          // Енергетичні зв'язки Plexus між вузлами
          float lineX = abs(f.x - offset.x);
          float lineY = abs(f.y - offset.y);
          float plexus = (0.0012 * (0.3 + u_mid)) / (min(lineX, lineY) + 0.008);

          vec3 layerCol = palette(h + layer * 0.25 + u_time * 0.1);
          col += layerCol * (ptSize * 0.18 + plexus * 0.22) / layer;
        }
        return col;
      }

      // 8: TOUCHDESIGNER REACTION-DIFFUSION & FEEDBACK TRAILS
      vec3 sceneReaction(vec2 uv) {
        vec2 p = uv * (3.0 + u_xy.x * 4.0);
        float t = u_time * (0.6 + u_xy.y * 1.2);

        // Багатошаровий Domain Warping (імітація Slope + Displace Feedback TOP)
        vec2 q = vec2(
          noise2D(p + vec2(0.0, t * 0.4)),
          noise2D(p + vec2(5.2, -t * 0.3))
        );
        vec2 r = vec2(
          noise2D(p + 3.5 * q + vec2(1.7, 9.2) + t * (0.5 + u_bass * 0.6)),
          noise2D(p + 3.5 * q + vec2(8.3, 2.8) - t * (0.4 + u_mid * 0.6))
        );

        float f = noise2D(p + (3.5 + u_subBass * 3.0) * r);
        float ridges = abs(sin(f * (12.0 + u_high * 8.0) + u_time * 1.5));
        float glow = (0.04 + u_subBass * 0.04) / (ridges + 0.03);

        vec3 col = palette(f * 0.8 + length(q) * 0.4 + u_time * 0.08) * glow * 0.42;
        return col;
      }

      // 9+: DYNAMIC CUSTOM SCENE FROM FX LAB STUDIO (studio.html)
      vec3 sceneCustom(vec2 uv) {
        ${customGlsl}
      }

      // Базовий рендер обраної сцени + медіа-шару (для підтримки RGB Split та Sobel Edges)
      vec3 evalSceneAndMedia(vec2 uv) {
        vec3 col = vec3(0.0);
        if (u_mode == 0) col = sceneLasers(uv);
        else if (u_mode == 1) col = sceneBlobTrack(uv);
        else if (u_mode == 2) col = scenePointCloud(uv);
        else if (u_mode == 3) col = sceneReaction(uv);
        else if (u_mode == 4) col = sceneSynthwave(uv);
        else if (u_mode == 5) col = sceneFerrofluid(uv);
        else if (u_mode == 6) col = sceneTunnel(uv);
        else if (u_mode == 7) col = sceneLiquid(uv);
        else if (u_mode == 8) col = sceneFractal(uv);
        else col = sceneCustom(uv);

        // Змішування з власним Відео / Фото / Камерою (Media TOP)
        if (u_mediaMix > 0.01) {
          vec2 texUv = gl_FragCoord.xy / u_resolution.xy;
          if (u_mediaMode == 1) {
            // Режим Audio Displace (відео/фото деформується хвилями басу та шейдера)
            texUv += (col.rg - 0.2) * (0.04 + u_subBass * 0.08);
          }
          texUv = clamp(texUv, 0.001, 0.999);
          vec3 mediaCol = texture2D(u_mediaTex, texUv).rgb;

          if (u_mediaMode == 2) {
            // Режим Neon Cyberpunk Mask (підсвічення яскравості відео/фото неоновою палітрою)
            float luma = dot(mediaCol, vec3(0.299, 0.587, 0.114));
            vec3 neonMedia = palette(luma * 1.5 + u_time * 0.2) * pow(luma * 1.3, 1.5) * (1.0 + u_subBass);
            col = mix(col, neonMedia + col * 0.4, u_mediaMix);
          } else {
            // Режим 0: Add / Screen / Proportional Overlay
            vec3 blended = mix(col, mediaCol, min(1.0, u_mediaMix * 1.15));
            col = blended + mediaCol * u_beatIntensity * 0.15;
          }
        }

        return col;
      }

      void main() {
        vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);

        // 1. FILMORA / TD FX: LED PIXELATE & HALFTONE MATRIX
        float ledMask = 1.0;
        if (u_fxPixelate > 0.02) {
          float cells = mix(140.0, 24.0, u_fxPixelate);
          vec2 cellUv = fract(uv * cells) - 0.5;
          uv = (floor(uv * cells) + 0.5) / cells;
          ledMask = smoothstep(0.48, 0.28, length(cellUv));
        }

        // 2. FILMORA / TD FX: VHS & SLICE GLITCH
        float scanlineMask = 1.0;
        if (u_fxGlitch > 0.02) {
          float sliceY = floor(uv.y * (18.0 + u_fxGlitch * 20.0));
          float glitchNoise = hash21(vec2(sliceY, floor(u_time * 16.0)));
          if (glitchNoise > 1.0 - u_fxGlitch * 0.48) {
            uv.x += (glitchNoise - 0.5) * 0.28 * u_fxGlitch * (0.5 + u_subBass);
          }
          scanlineMask = 1.0 - u_fxGlitch * 0.35 * (0.5 + 0.5 * sin(gl_FragCoord.y * 1.8 + u_time * 20.0));
        }

        // 3. FILMORA / TD FX: MIRROR KALEIDOSCOPE
        if (u_fxKaleido > 0.05) {
          float segments = floor(2.0 + u_fxKaleido * 8.0);
          float angle = atan(uv.y, uv.x);
          float radius = length(uv);
          float segAngle = 2.0 * PI / segments;
          angle = mod(angle + u_time * 0.15, segAngle);
          angle = abs(angle - segAngle * 0.5);
          uv = vec2(cos(angle), sin(angle)) * radius;
        }

        // 4. TOUCHDESIGNER FX: CURL FEEDBACK / DISPLACE WARP
        if (u_fxFeedback > 0.02) {
          float warpFreq = 3.5 + u_fxFeedback * 4.0;
          vec2 warp = vec2(
            sin(uv.y * warpFreq + u_time * 2.2 + u_bass * 3.0),
            cos(uv.x * warpFreq - u_time * 1.9 + u_mid * 3.0)
          );
          uv += warp * u_fxFeedback * (0.09 + u_subBass * 0.08);
        }

        // 💥 LIVE FX: SHOCKWAVE
        if (u_shockwave > 0.01) {
          float dist = length(uv);
          float waveRadius = u_shockwave * 1.4;
          float band = smoothstep(waveRadius - 0.12, waveRadius, dist) *
                       smoothstep(waveRadius + 0.12, waveRadius, dist);
          uv += normalize(uv + 0.0001) * band * 0.18 * (1.0 - u_shockwave);
        }

        // Ударний зум камери на бочку
        uv *= 1.0 - u_beatIntensity * 0.06;

        // 5. FILMORA FX: CHROMATIC ABERRATION (RGB SPLIT)
        vec3 col;
        if (u_fxRgbSplit > 0.01) {
          vec2 shift = normalize(uv + 0.0001) * (0.004 + u_fxRgbSplit * 0.045) * (0.6 + u_subBass * 0.9);
          float r = evalSceneAndMedia(uv + shift).r;
          float g = evalSceneAndMedia(uv).g;
          float b = evalSceneAndMedia(uv - shift).b;
          col = vec3(r, g, b);
        } else {
          col = evalSceneAndMedia(uv);
        }

        // 6. TOUCHDESIGNER / FILMORA FX: NEON EDGE DETECT (Edge TOP)
        if (u_fxEdges > 0.02) {
          float eps = 0.006;
          vec3 cR = evalSceneAndMedia(uv + vec2(eps, 0.0));
          vec3 cU = evalSceneAndMedia(uv + vec2(0.0, eps));
          vec3 edge = abs(col - cR) + abs(col - cU);
          float edgeMag = length(edge) * 3.8;
          vec3 neonEdge = palette(edgeMag + u_time * 0.3) * edgeMag * 2.2;
          col = mix(col, neonEdge, u_fxEdges);
        }

        col *= ledMask * scanlineMask;

        // Кільце Shockwave поверх сцени
        if (u_shockwave > 0.01) {
          float ringDist = abs(length(uv) - u_shockwave * 1.4);
          col += palette(u_time + 0.5) * (0.015 / (ringDist + 0.008)) * (1.0 - u_shockwave) * 2.0;
        }

        // ⚡ LIVE FX: STROBE
        if (u_strobe > 0.5) {
          float flash = step(0.45, fract(u_time * 18.0));
          col = mix(col, vec3(1.0) - col * 0.3, flash * 0.85);
        }

        // Tone mapping + True Black поріг для проекторів
        col = col / (1.0 + col * 0.35);
        col = smoothstep(0.02, 1.0, col);

        if (u_projectorMask > 0.5) {
          vec2 q = gl_FragCoord.xy / u_resolution.xy;
          float vig = pow(16.0 * q.x * q.y * (1.0 - q.x) * (1.0 - q.y), 0.22);
          col *= vig;
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return false;

    const newProgram = gl.createProgram();
    gl.attachShader(newProgram, vs);
    gl.attachShader(newProgram, fs);
    gl.linkProgram(newProgram);
    if (!gl.getProgramParameter(newProgram, gl.LINK_STATUS)) {
      console.error("Program link error:", gl.getProgramInfoLog(newProgram));
      return false;
    }

    this.program = newProgram;
    gl.useProgram(this.program);

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    if (!this.mediaTexture) {
      this.mediaTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.mediaTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255])
      );
    }

    this.uniforms = {
      u_resolution: gl.getUniformLocation(this.program, "u_resolution"),
      u_time: gl.getUniformLocation(this.program, "u_time"),
      u_mode: gl.getUniformLocation(this.program, "u_mode"),
      u_subBass: gl.getUniformLocation(this.program, "u_subBass"),
      u_bass: gl.getUniformLocation(this.program, "u_bass"),
      u_mid: gl.getUniformLocation(this.program, "u_mid"),
      u_high: gl.getUniformLocation(this.program, "u_high"),
      u_beatIntensity: gl.getUniformLocation(this.program, "u_beatIntensity"),
      u_beatPhase: gl.getUniformLocation(this.program, "u_beatPhase"),
      u_beatCount: gl.getUniformLocation(this.program, "u_beatCount"),
      u_xy: gl.getUniformLocation(this.program, "u_xy"),
      u_colorShift: gl.getUniformLocation(this.program, "u_colorShift"),
      u_strobe: gl.getUniformLocation(this.program, "u_strobe"),
      u_shockwave: gl.getUniformLocation(this.program, "u_shockwave"),
      u_projectorMask: gl.getUniformLocation(this.program, "u_projectorMask"),
      u_fxRgbSplit: gl.getUniformLocation(this.program, "u_fxRgbSplit"),
      u_fxGlitch: gl.getUniformLocation(this.program, "u_fxGlitch"),
      u_fxKaleido: gl.getUniformLocation(this.program, "u_fxKaleido"),
      u_fxEdges: gl.getUniformLocation(this.program, "u_fxEdges"),
      u_fxFeedback: gl.getUniformLocation(this.program, "u_fxFeedback"),
      u_fxPixelate: gl.getUniformLocation(this.program, "u_fxPixelate"),
      u_mediaTex: gl.getUniformLocation(this.program, "u_mediaTex"),
      u_mediaMix: gl.getUniformLocation(this.program, "u_mediaMix"),
      u_mediaMode: gl.getUniformLocation(this.program, "u_mediaMode"),
    };
    return true;
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      this.lastShaderError = gl.getShaderInfoLog(shader);
      console.error("Shader compile error:", this.lastShaderError);
      return null;
    }
    this.lastShaderError = null;
    return shader;
  }

  compileCustomScene(customGlsl) {
    const ok = this.initWebGL(customGlsl);
    if (ok) {
      this.customSceneGlsl = customGlsl;
    }
    return ok;
  }

  registerCustomEffect(effect) {
    if (!effect || !effect.id) return false;
    this.customEffects[effect.id] = effect;
    if (!this.modes.includes(effect.id)) {
      this.modes.push(effect.id);
    }
    if (effect.glsl) {
      this.compileCustomScene(effect.glsl);
    }
    return true;
  }

  setMode(modeNameOrIndex) {
    if (typeof modeNameOrIndex === "number") {
      this.modeIndex = modeNameOrIndex % this.modes.length;
    } else {
      const idx = this.modes.indexOf(modeNameOrIndex);
      if (idx !== -1) {
        this.modeIndex = idx;
        const custom = this.customEffects[modeNameOrIndex];
        if (custom && custom.glsl && custom.glsl !== this.customSceneGlsl) {
          this.compileCustomScene(custom.glsl);
        }
      }
    }
  }

  setXY(x, y) {
    this.xy.x = Math.max(0, Math.min(1, x));
    this.xy.y = Math.max(0, Math.min(1, y));
  }

  setPostFx(name, val) {
    if (name in this.postFx) {
      this.postFx[name] = Math.max(0, Math.min(1, Number(val) || 0));
    }
  }

  setChopRoute(name, source) {
    if (name in this.chopRouting) {
      this.chopRouting[name] = source;
    }
  }

  setMediaSource(element) {
    this.mediaElement = element;
    this.hasMedia = !!element;
    this.mediaNeedsUpload = true;
    if (this.hasMedia && this.mediaMix < 0.1) {
      this.mediaMix = 0.75;
    }
  }

  clearMediaSource() {
    this.mediaElement = null;
    this.hasMedia = false;
    this.mediaNeedsUpload = false;
    this.mediaMix = 0.0;
  }

  triggerShockwave() {
    this.fx.shockwave = 0.02;
  }

  triggerColorDrop() {
    this.colorShift = (this.colorShift + 0.27) % 1.0;
    this.triggerShockwave();
  }

  /**
   * Обчислює модуляцію кожного FX-параметра від обраного каналу Audio-CHOP (як у TouchDesigner)
   */
  computeModulatedFx(dspState) {
    const lfo = 0.5 + 0.5 * Math.sin(this.accumulatedTime * 2.2);
    const sources = {
      none: 0,
      subBass: dspState.subBass || 0,
      bass: dspState.bass || 0,
      mid: dspState.mid || 0,
      high: dspState.high || 0,
      lfo,
    };

    for (const key of Object.keys(this.postFx)) {
      const base = this.postFx[key];
      const route = this.chopRouting[key] || "none";
      const modAmount = route === "none" ? 0 : (sources[route] || 0) * 0.55;
      // Якщо базовий слайдер > 0 або обраний активний CHOP-канал, застосовуємо модуляцію
      const activeMod = base > 0.01 ? base + modAmount * (1.0 - base * 0.3) : 0.0;
      this.effectivePostFx[key] = Math.min(1.0, activeMod);
    }
  }

  updateMediaTexture() {
    if (!this.hasMedia || !this.mediaElement || this.mediaMix <= 0.01) return;
    const gl = this.gl;
    const isVideo = this.mediaElement instanceof HTMLVideoElement;
    if (!isVideo && !this.mediaNeedsUpload) {
      // Статичне фото вже завантажено в текстуру GPU — не перезавантажуємо щокадрово
      return;
    }
    try {
      if (isVideo && this.mediaElement.readyState < 2) return;
      if (!isVideo && (!this.mediaElement.complete || this.mediaElement.naturalWidth === 0)) return;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.mediaTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.mediaElement
      );
      this.mediaNeedsUpload = false;
    } catch {
      // Безпечний пропуск кадру, якщо відео ще буферизується
    }
  }

  /**
   * Рендер TouchDesigner Computer Vision Blob Tracking HUD, Keystone-маски та B2B/PRO оверлеїв
   */
  renderBlobOverlay(dspState, dt) {
    if (!this.overlayCanvas || !this.overlayCtx) return;
    const ctx = this.overlayCtx;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // Показуємо CV-розмітку якщо увімкнений переключатель Blob HUD або активна сцена blobtrack
    const active = this.blobHudEnabled || this.modes[this.modeIndex] === "blobtrack";
    if (active) {
      const speedMul = 0.5 + (dspState.bass || 0) * 1.8;

      // Оновлюємо координати трекінгових вузлів
      this.trackedBlobs.forEach((b, i) => {
        const bandVal = dspState[b.band] || 0.3;
        b.x += b.vx * dt * speedMul;
        b.y += b.vy * dt * speedMul;

        // Плавний рух за орбітами шейдера + відскок від країв
        const orbitX = 0.5 + Math.sin(this.accumulatedTime * 0.9 + i * 1.3) * 0.32;
        const orbitY = 0.5 + Math.cos(this.accumulatedTime * 0.75 - i * 1.1) * 0.28;
        b.x = b.x * 0.92 + orbitX * 0.08;
        b.y = b.y * 0.92 + orbitY * 0.08;

        if (b.x < 0.12 || b.x > 0.88) b.vx *= -1;
        if (b.y < 0.15 || b.y > 0.85) b.vy *= -1;

        b.currentSize = (b.size + bandVal * 95) * (w / 900 + 0.45);
        b.px = b.x * w;
        b.py = b.y * h;
        b.val = bandVal;
      });

      ctx.save();
      // 1. Векторні лінії зв'язку (Spline / Plexus Connections)
      ctx.lineWidth = 1.5;
      for (let i = 0; i < this.trackedBlobs.length; i++) {
        for (let j = i + 1; j < this.trackedBlobs.length; j++) {
          const a = this.trackedBlobs[i];
          const b = this.trackedBlobs[j];
          const dist = Math.hypot(a.px - b.px, a.py - b.py);
          const maxDist = Math.min(w, h) * 0.48;
          if (dist < maxDist) {
            const alpha = (1.0 - dist / maxDist) * 0.55;
            ctx.strokeStyle = `rgba(244, 244, 246, ${alpha.toFixed(2)})`;
            ctx.beginPath();
            ctx.moveTo(a.px, a.py);
            // Крива Безьє як у TouchDesigner CHOP trail
            const midX = (a.px + b.px) * 0.5;
            const midY = (a.py + b.py) * 0.5 - 24 * (dspState.subBass || 0);
            ctx.quadraticCurveTo(midX, midY, b.px, b.py);
            ctx.stroke();
          }
        }
      }

      // 2. Рамки комп'ютерного зору (Bounding Boxes + Crosshairs + Координати)
      const fontSize = Math.max(10, Math.round(w * 0.012));
      ctx.font = `600 ${fontSize}px "SF Mono", "JetBrains Mono", monospace`;

      this.trackedBlobs.forEach((b, idx) => {
        const half = b.currentSize * 0.5;
        const x0 = b.px - half;
        const y0 = b.py - half;
        const isKick = idx % 2 === 0 && dspState.beatIntensity > 0.45;
        const color = isKick ? "#ff5722" : "rgba(244, 244, 246, 0.85)";

        ctx.strokeStyle = "rgba(244, 244, 246, 0.28)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x0, y0, b.currentSize, b.currentSize);

        // Кутові акценти рамки
        const corner = Math.max(6, b.currentSize * 0.18);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0, y0 + corner);
        ctx.lineTo(x0, y0);
        ctx.lineTo(x0 + corner, y0);
        ctx.moveTo(x0 + b.currentSize - corner, y0);
        ctx.lineTo(x0 + b.currentSize, y0);
        ctx.lineTo(x0 + b.currentSize, y0 + corner);
        ctx.stroke();

        // Приціл у центрі
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(b.px - 4, b.py);
        ctx.lineTo(b.px + 4, b.py);
        ctx.moveTo(b.px, b.py - 4);
        ctx.lineTo(b.px, b.py + 4);
        ctx.stroke();

        // Підпис ID та живих координат [x, y, amp]
        const label = `${b.id} [${b.x.toFixed(2)}, ${b.y.toFixed(2)}] ${(b.val * 100).toFixed(0)}%`;
        ctx.fillStyle = "rgba(7, 7, 9, 0.82)";
        ctx.fillRect(x0, y0 - fontSize - 6, ctx.measureText(label).width + 8, fontSize + 5);
        ctx.fillStyle = color;
        ctx.fillText(label, x0 + 4, y0 - 4);
      });

      ctx.restore();
    }

    // 3. B2B Вивіска закладу / DJ Stage Text (PRO-функція для барів, вечірок та стрімів)
    if (this.venueOverlay.enabled && this.venueOverlay.title) {
      ctx.save();
      const pulse = 1.0 + (dspState.subBass || 0) * 0.14;
      const baseTitleSize = Math.max(18, Math.round(w * 0.036));
      ctx.translate(w * 0.5, h * 0.14);
      ctx.scale(pulse, pulse);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.font = `800 ${baseTitleSize}px "Inter", system-ui, sans-serif`;
      ctx.shadowColor = dspState.beatIntensity > 0.5 ? "#ff5722" : "#00f5d4";
      ctx.shadowBlur = 18 + (dspState.subBass || 0) * 24;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(this.venueOverlay.title.toUpperCase(), 0, 0);

      if (this.venueOverlay.subtitle) {
        const subSize = Math.max(11, Math.round(w * 0.014));
        ctx.font = `600 ${subSize}px "SF Mono", "JetBrains Mono", monospace`;
        ctx.shadowBlur = 8;
        ctx.fillStyle = "rgba(0, 245, 212, 0.9)";
        ctx.fillText(this.venueOverlay.subtitle, 0, baseTitleSize * 0.78);
      }
      ctx.restore();
    }

    // 4. Keystone / Room Masking (True Black #000000 обрізка країв для точного вписування в стіну/картину)
    const padX = Math.max(0, Math.min(0.4, this.keystone.cropX + (1.0 - this.keystone.scale) * 0.5));
    const padY = Math.max(0, Math.min(0.4, this.keystone.cropY + (1.0 - this.keystone.scale) * 0.5));
    if (padX > 0.005 || padY > 0.005) {
      ctx.save();
      ctx.fillStyle = "#000000";
      const cropW = Math.round(w * padX);
      const cropH = Math.round(h * padY);
      if (cropW > 0) {
        ctx.fillRect(0, 0, cropW, h);
        ctx.fillRect(w - cropW, 0, cropW, h);
      }
      if (cropH > 0) {
        ctx.fillRect(0, 0, w, cropH);
        ctx.fillRect(0, h - cropH, w, cropH);
      }
      ctx.restore();
    }

    // 5. Вірусний водяний знак у FREE-версії (повністю зникає при активації PRO)
    if (!this.isPro) {
      ctx.save();
      const wmFont = Math.max(10, Math.round(w * 0.0105));
      ctx.font = `600 ${wmFont}px "SF Mono", "JetBrains Mono", monospace`;
      const wmText = `AURA VJ FREE · ROOM ${this.roomId}`;
      const metrics = ctx.measureText(wmText);
      const pad = 8;
      const bx = w - metrics.width - pad * 2 - 18;
      const by = 16;
      ctx.fillStyle = "rgba(5, 5, 8, 0.65)";
      ctx.fillRect(bx, by, metrics.width + pad * 2, wmFont + 10);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
      ctx.strokeRect(bx, by, metrics.width + pad * 2, wmFont + 10);
      ctx.fillStyle = "rgba(244, 244, 246, 0.55)";
      ctx.fillText(wmText, bx + pad, by + wmFont + 1);
      ctx.restore();
    }
  }

  updateAutoFpsScaler(now) {
    this.fpsFrames++;
    const elapsed = now - this.fpsLastCheck;
    if (elapsed >= 900) {
      this.currentFps = Math.round((this.fpsFrames * 1000) / elapsed);
      this.fpsFrames = 0;
      this.fpsLastCheck = now;

      // Якщо FPS просідає на бюджетному проекторі (< 46 FPS) — знижуємо внутрішній буфер WebGL
      if (this.currentFps < 46 && this.renderScale > 0.5) {
        this.renderScale = Math.max(0.5, Number((this.renderScale - 0.15).toFixed(2)));
        this.applyCanvasResolution();
      } else if (this.currentFps >= 57 && this.renderScale < 1.0) {
        this.renderScale = Math.min(1.0, Number((this.renderScale + 0.1).toFixed(2)));
        this.applyCanvasResolution();
      }
    }
  }

  render(dspState, now = performance.now()) {
    const dt = Math.min(0.1, (now - this.lastTimestamp) / 1000);
    this.lastTimestamp = now;

    this.updateAutoFpsScaler(now);

    const timeScale = this.fx.freeze ? 0.06 : 1.0 + dspState.subBass * 0.45;
    this.accumulatedTime += dt * timeScale;

    if (this.fx.shockwave > 0) {
      this.fx.shockwave += dt * 1.65;
      if (this.fx.shockwave >= 1.0) this.fx.shockwave = 0.0;
    }

    this.computeModulatedFx(dspState);
    this.updateMediaTexture();

    const gl = this.gl;
    if (!gl) return;

    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.u_resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.u_time, this.accumulatedTime);
    gl.uniform1i(this.uniforms.u_mode, this.modeIndex);
    gl.uniform1f(this.uniforms.u_subBass, dspState.subBass);
    gl.uniform1f(this.uniforms.u_bass, dspState.bass);
    gl.uniform1f(this.uniforms.u_mid, dspState.mid);
    gl.uniform1f(this.uniforms.u_high, dspState.high);
    gl.uniform1f(this.uniforms.u_beatIntensity, dspState.beatIntensity);
    gl.uniform1f(this.uniforms.u_beatPhase, dspState.beatPhase);
    gl.uniform1f(this.uniforms.u_beatCount, dspState.beatCount);
    gl.uniform2f(this.uniforms.u_xy, this.xy.x, this.xy.y);
    gl.uniform1f(this.uniforms.u_colorShift, this.colorShift);
    gl.uniform1f(this.uniforms.u_strobe, this.fx.strobe ? 1.0 : 0.0);
    gl.uniform1f(this.uniforms.u_shockwave, this.fx.shockwave);
    gl.uniform1f(this.uniforms.u_projectorMask, this.trueBlackProjectorMask ? 1.0 : 0.0);

    // Передаємо стек Filmora + TouchDesigner Post-FX
    gl.uniform1f(this.uniforms.u_fxRgbSplit, this.effectivePostFx.rgbSplit);
    gl.uniform1f(this.uniforms.u_fxGlitch, this.effectivePostFx.glitch);
    gl.uniform1f(this.uniforms.u_fxKaleido, this.effectivePostFx.kaleido);
    gl.uniform1f(this.uniforms.u_fxEdges, this.effectivePostFx.edges);
    gl.uniform1f(this.uniforms.u_fxFeedback, this.effectivePostFx.feedback);
    gl.uniform1f(this.uniforms.u_fxPixelate, this.effectivePostFx.pixelate);

    // Медіа-текстура
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mediaTexture);
    gl.uniform1i(this.uniforms.u_mediaTex, 0);
    gl.uniform1f(this.uniforms.u_mediaMix, this.hasMedia ? this.mediaMix : 0.0);
    gl.uniform1i(this.uniforms.u_mediaMode, this.mediaBlendMode);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Малюємо TouchDesigner CV Blob Tracking HUD поверх WebGL
    this.renderBlobOverlay(dspState, dt);
  }
}

window.ShaderVisualizer = ShaderVisualizer;
