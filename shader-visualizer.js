/**
 * GPU WebGL Fragment Shader Visualizer Engine
 * Підтримує 6 професійних шейдерних сцен у 60 FPS + True Black режим для проекторів
 * та миттєві Live DJ FX тригери (Strobe, Shockwave, Freeze, Color Drop, XY Morph Pad)
 */
class ShaderVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl =
      canvas.getContext("webgl", { alpha: false, antialias: true, preserveDrawingBuffer: true }) ||
      canvas.getContext("experimental-webgl");

    this.modeIndex = 0; // 0: lasers, 1: synthwave, 2: ferrofluid, 3: tunnel, 4: liquid, 5: fractal
    this.modes = ["lasers", "synthwave", "ferrofluid", "tunnel", "liquid", "fractal"];

    this.xy = { x: 0.5, y: 0.5 };
    this.colorShift = 0.0;
    this.trueBlackProjectorMask = true;

    // Активні Live DJ ефекти
    this.fx = {
      strobe: false,
      shockwave: 0.0, // 0..1 прогрес хвилі
      freeze: false,
    };

    this.accumulatedTime = 0;
    this.lastTimestamp = performance.now();

    this.initWebGL();
    this.setupResizeObserver();
  }

  setupResizeObserver() {
    const observer = new ResizeObserver(([entry]) => {
      const dpc = entry.devicePixelContentBoxSize;
      // Обмежуємо максимальний DPI до 2x для 60 FPS на мобільних та ТВ
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = dpc
        ? Math.min(dpc[0].inlineSize, Math.round(entry.contentRect.width * 2))
        : Math.round(entry.contentRect.width * dpr);
      this.canvas.height = dpc
        ? Math.min(dpc[0].blockSize, Math.round(entry.contentRect.height * 2))
        : Math.round(entry.contentRect.height * dpr);

      if (this.gl) {
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }
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

  initWebGL() {
    const gl = this.gl;
    if (!gl) return;

    const vsSource = `
      attribute vec2 a_position;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision highp float;

      uniform vec2 u_resolution;
      uniform float u_time;
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

      #define PI 3.14159265359

      mat2 rot(float a) {
        float s = sin(a), c = cos(a);
        return mat2(c, -s, s, c);
      }

      // Косинусна неонова палітра Ініго Кілеса
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

      // 0: GALVO LASER MATRIX, DIFFRACTION STARS & COSMIC NEBULA (як на DJ-проекторі)
      float sdSegment(vec2 p, vec2 a, vec2 b) {
        vec2 pa = p - a, ba = b - a;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - ba * h);
      }

      vec3 sceneLasers(vec2 uv) {
        vec3 col = vec3(0.0);
        float spread = 0.45 + u_xy.x * 1.35;
        float speed = 0.65 + u_xy.y * 1.5;

        // 1. Космічна лазерна туманність (Red/Magenta & Emerald Nebula Cloud як у DJ)
        vec2 nebUv = uv * rot(u_time * 0.08);
        float n1 = sin(nebUv.x * 3.2 + u_time * 0.4) * cos(nebUv.y * 2.8 - u_time * 0.3);
        float n2 = sin(nebUv.x * 6.5 - nebUv.y * 5.2 + u_time * 0.7);
        float nebulaMask = smoothstep(-0.2, 0.85, n1 * 0.6 + n2 * 0.4) * exp(-length(uv) * 1.15);
        vec3 nebRed = vec3(0.95, 0.05, 0.28) * smoothstep(0.0, 0.7, n1);
        vec3 nebGreen = vec3(0.0, 0.95, 0.35) * smoothstep(0.1, 0.8, n2);
        col += (nebRed * (0.18 + u_bass * 0.32) + nebGreen * (0.12 + u_mid * 0.25)) * nebulaMask;

        // 2. Зелена дифракційна зоряна решітка (Laser Starfield Dots)
        vec2 starUv = uv * rot(-u_time * 0.05) * (14.0 + u_xy.x * 8.0);
        vec2 starId = floor(starUv);
        vec2 starF = fract(starUv) - 0.5;
        float sh = hash21(starId);
        if (sh > 0.68) {
          vec2 starOffset = vec2(fract(sh * 13.7) - 0.5, fract(sh * 29.3) - 0.5) * 0.6;
          float starDist = length(starF - starOffset);
          float twinkle = 0.5 + 0.5 * sin(u_time * 6.0 + sh * 50.0);
          float starGlow = (0.0025 * (0.4 + u_high * 1.6) * twinkle) / (starDist * starDist + 0.0015);
          vec3 starCol = (sh > 0.91) ? vec3(1.0, 0.15, 0.35) : vec3(0.1, 1.0, 0.35);
          col += starCol * starGlow * 0.16;
        }

        // 3. Galvo X-Y Скануючі Лазерні Фігури з яскравими вузловими точками на кінцях
        for (float i = 0.0; i < 6.0; i += 1.0) {
          float phase = u_time * speed * 0.9 + i * 1.047 + floor(u_beatCount) * 0.55;
          vec2 pA = vec2(
            sin(phase * 1.3 + i) * (0.55 + u_bass * 0.25) * spread,
            cos(phase * 0.9 - i * 0.7) * (0.42 + u_subBass * 0.2)
          );
          vec2 pB = vec2(
            sin(phase * 0.8 - i * 1.4 + 1.5) * (0.6 + u_mid * 0.25) * spread,
            cos(phase * 1.5 + i * 1.1) * (0.45 + u_bass * 0.2)
          );

          float segDist = sdSegment(uv, pA, pB);
          // Гострий лазерний промінь
          float laserLine = (0.0016 + u_subBass * 0.002) / (segDist + 0.001);
          // Яскраві точки зупинки дзеркал гальванометра на кінцях лінії (як на скріншоті DJ)
          float endDots = (0.0025 + u_beatIntensity * 0.003) / (min(length(uv - pA), length(uv - pB)) + 0.003);

          vec3 galvoCol = (mod(i, 2.0) < 0.5)
            ? mix(vec3(0.05, 1.0, 0.35), palette(i * 0.15 + u_time * 0.1), u_colorShift)
            : mix(vec3(1.0, 0.08, 0.32), palette(i * 0.15 + 0.4 + u_time * 0.1), u_colorShift);

          col += galvoCol * laserLine * 0.32;
          col += mix(galvoCol, vec3(1.0), 0.55) * endDots * 0.38;
        }

        // 4. Віялові клубні промені зверху (Liquid Sky)
        for (float i = -4.0; i <= 4.0; i += 1.0) {
          float angle = i * 0.16 * spread + sin(u_time * speed + i * 0.7) * (0.22 + u_mid * 0.35);
          angle += sin(u_beatCount * 1.7 + i) * 0.15 * u_beatIntensity;

          vec2 origin = vec2(0.0, 0.88);
          vec2 p = uv - origin;
          vec2 dir = normalize(vec2(sin(angle), -cos(angle)));
          float proj = max(0.0, dot(p, dir));
          float dist = length(p - dir * proj);

          float beam = (0.0012 + u_subBass * 0.0018) / (dist + 0.0015);
          beam *= smoothstep(0.0, 0.15, proj) * smoothstep(2.3, 0.3, proj);
          col += palette(i * 0.09 + u_time * 0.15) * beam * 0.2;
        }

        return col;
      }

      // 1: 3D SYNTHWAVE AUDIO TERRAIN
      vec3 sceneSynthwave(vec2 uv) {
        vec3 col = vec3(0.0);
        float horizon = -0.05 + (u_xy.y - 0.5) * 0.35;

        // Ретро-сонце, що пульсує від Sub-Bass
        vec2 sunUv = uv - vec2(0.0, horizon + 0.36);
        float sunRadius = 0.28 + u_subBass * 0.09;
        float sunDist = length(sunUv);
        if (sunDist < sunRadius) {
          float stripes = sin((sunUv.y + u_time * 0.06) * 48.0);
          float mask = smoothstep(-0.1, 0.05, stripes + sunUv.y * 2.5);
          vec3 sunCol = mix(vec3(1.0, 0.08, 0.55), vec3(1.0, 0.85, 0.1), (sunUv.y + sunRadius) / (2.0 * sunRadius));
          col += sunCol * mask;
        }
        // Світіння сонця
        col += vec3(0.95, 0.1, 0.6) * (0.028 / (abs(sunDist - sunRadius) + 0.04)) * (0.6 + u_subBass * 0.7);

        // 3D перспектива підлоги та гір
        if (uv.y < horizon) {
          float z = 1.0 / abs(uv.y - horizon);
          float x = uv.x * z * (0.8 + u_xy.x * 0.8);

          // Ефект гір з боків (висота залежить від басу та середини)
          float mountainWave = sin(x * 0.6) * cos(z * 0.3 - u_time * 3.5);
          float elevation = smoothstep(1.2, 4.5, abs(x)) * mountainWave * (0.3 + u_bass * 0.8);

          float gridX = abs(fract(x + elevation) - 0.5);
          float gridZ = abs(fract(z * 0.5 - u_time * (2.5 + u_subBass * 2.0)) - 0.5);
          float line = min(gridX, gridZ);

          float glow = 0.018 / (line + 0.012);
          float fog = exp(-z * 0.08);
          vec3 gridCol = palette(z * 0.04 - u_time * 0.2 + abs(x) * 0.05);
          col += gridCol * glow * fog * (0.7 + u_mid * 0.8);
        } else {
          // Зоряний пил на високих частотах
          vec2 starGrid = floor((uv + vec2(u_time * 0.02, 0.0)) * 35.0);
          float h = hash21(starGrid);
          if (h > 0.96) {
            float twinkle = sin(u_time * 8.0 + h * 40.0) * 0.5 + 0.5;
            col += vec3(0.4, 0.9, 1.0) * twinkle * (0.3 + u_high * 1.5);
          }
        }
        // Лінія горизонту
        col += vec3(0.0, 1.0, 0.9) * (0.004 / (abs(uv.y - horizon) + 0.003)) * (1.0 + u_beatIntensity);
        return col;
      }

      // 2: 3D FERROFLUID PLASMA SPHERE
      vec3 sceneFerrofluid(vec2 uv) {
        vec3 col = vec3(0.0);
        float r = length(uv);
        float a = atan(uv.y, uv.x);

        // Гармоніки шипів феррофлюїду від частот та XY-паду
        float spikes =
          sin(a * floor(6.0 + u_xy.x * 12.0) + u_time * 2.5) * u_bass * 0.14 +
          cos(a * floor(12.0 + u_xy.y * 16.0) - u_time * 4.0) * u_mid * 0.09 +
          sin(a * 24.0 + u_time * 7.0) * u_high * 0.05;

        float baseRadius = 0.28 + u_subBass * 0.18 + spikes;

        // 3D сферичне освітлення всередині краплі
        if (r < baseRadius) {
          float z = sqrt(max(0.0, baseRadius * baseRadius - r * r));
          vec3 normal = normalize(vec3(uv.x + spikes * 0.6, uv.y + spikes * 0.6, z));
          vec3 lightDir = normalize(vec3(cos(u_time * 1.5), sin(u_time * 1.2), 0.8));
          float diff = max(0.0, dot(normal, lightDir));
          float rim = pow(1.0 - max(0.0, normal.z), 2.5);

          vec3 coreCol = palette(r * 1.8 - u_time * 0.25 + diff * 0.4);
          col = coreCol * (0.25 + diff * 0.85) + palette(u_time * 0.5 + 0.3) * rim * 1.8;
          col += vec3(1.0) * pow(diff, 14.0) * (0.7 + u_high); // Металевий блік
        }

        // Зовнішня плазмова корона та кільця ударної хвилі
        float corona = (0.012 + u_subBass * 0.02) / (abs(r - baseRadius) + 0.008);
        col += palette(a / (2.0 * PI) + u_time * 0.2) * corona * 0.65;

        // Зовнішні орбітальні кільця на біт
        float ring = abs(r - (baseRadius + 0.14 + fract(u_beatPhase) * 0.35));
        col += palette(u_beatCount * 0.2) * (0.003 / (ring + 0.005)) * (1.0 - fract(u_beatPhase)) * (0.5 + u_subBass);

        return col;
      }

      // 3: CYBER INFINITY TUNNEL
      vec3 sceneTunnel(vec2 uv) {
        vec3 col = vec3(0.0);
        // Зміщення центру тунелю за пальцем на XY-тачпаді
        vec2 p = uv - (u_xy - 0.5) * 0.45;
        float a = atan(p.y, p.x);
        float r = length(p);

        // Геометрична форма перерізу (від трикутника до гексагона)
        float sides = floor(3.0 + u_xy.x * 5.0);
        float polyRadius = r * cos(PI / sides) / max(0.1, cos(mod(a + u_time * 0.3, 2.0 * PI / sides) - PI / sides));

        float depth = 0.35 / max(0.02, polyRadius) + u_time * (1.8 + u_xy.y * 2.5) + u_subBass * 0.6;
        float rings = abs(fract(depth) - 0.5);

        float radialBeams = abs(sin(a * sides * 2.0 + depth * 0.5));
        float pattern = min(rings, radialBeams * 0.4 + 0.05);

        float glow = (0.015 + u_beatIntensity * 0.02) / (pattern + 0.01);
        float centerFade = smoothstep(0.02, 0.22, r); // Чорна безодня в центрі

        col = palette(depth * 0.12 + u_time * 0.1) * glow * centerFade * 0.55;
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

      void main() {
        vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);

        // 💥 LIVE FX: SHOCKWAVE (Вибухова хвиля деформації простору)
        if (u_shockwave > 0.01) {
          float dist = length(uv);
          float waveRadius = u_shockwave * 1.4;
          float band = smoothstep(waveRadius - 0.12, waveRadius, dist) *
                       smoothstep(waveRadius + 0.12, waveRadius, dist);
          uv += normalize(uv + 0.0001) * band * 0.18 * (1.0 - u_shockwave);
        }

        // Легкий ударний зум камери на бочку
        uv *= 1.0 - u_beatIntensity * 0.06;

        vec3 col = vec3(0.0);
        if (u_mode == 0) col = sceneLasers(uv);
        else if (u_mode == 1) col = sceneSynthwave(uv);
        else if (u_mode == 2) col = sceneFerrofluid(uv);
        else if (u_mode == 3) col = sceneTunnel(uv);
        else if (u_mode == 4) col = sceneLiquid(uv);
        else col = sceneFractal(uv);

        // Кільце Shockwave поверх сцени
        if (u_shockwave > 0.01) {
          float ringDist = abs(length(uv) - u_shockwave * 1.4);
          col += palette(u_time + 0.5) * (0.015 / (ringDist + 0.008)) * (1.0 - u_shockwave) * 2.0;
        }

        // ⚡ LIVE FX: STROBE (Клубний стробоскоп)
        if (u_strobe > 0.5) {
          float flash = step(0.45, fract(u_time * 18.0));
          col = mix(col, vec3(1.0) - col * 0.3, flash * 0.85);
        }

        // Tone mapping + True Black поріг (щоб проектор не світив сірим фоном)
        col = col / (1.0 + col * 0.35);
        col = smoothstep(0.02, 1.0, col);

        // Віньєтка для проектора (плавне розчинення країв у абсолютну темряву #000000)
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
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.useProgram(this.program);

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(this.program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

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
    };
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("Shader compile error:", gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  setMode(modeNameOrIndex) {
    if (typeof modeNameOrIndex === "number") {
      this.modeIndex = modeNameOrIndex % this.modes.length;
    } else {
      const idx = this.modes.indexOf(modeNameOrIndex);
      if (idx !== -1) this.modeIndex = idx;
    }
  }

  setXY(x, y) {
    this.xy.x = Math.max(0, Math.min(1, x));
    this.xy.y = Math.max(0, Math.min(1, y));
  }

  triggerShockwave() {
    this.fx.shockwave = 0.02;
  }

  triggerColorDrop() {
    this.colorShift = (this.colorShift + 0.27) % 1.0;
    this.triggerShockwave();
  }

  render(dspState, now = performance.now()) {
    const dt = Math.min(0.1, (now - this.lastTimestamp) / 1000);
    this.lastTimestamp = now;

    // ❄️ LIVE FX: FREEZE (сповільнення часу в 12 разів перед дропом)
    const timeScale = this.fx.freeze ? 0.06 : 1.0 + dspState.subBass * 0.45;
    this.accumulatedTime += dt * timeScale;

    if (this.fx.shockwave > 0) {
      this.fx.shockwave += dt * 1.65;
      if (this.fx.shockwave >= 1.0) this.fx.shockwave = 0.0;
    }

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

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

window.ShaderVisualizer = ShaderVisualizer;
