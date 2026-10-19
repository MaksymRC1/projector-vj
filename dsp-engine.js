/**
 * Next-Gen DSP Audio & Rhythm Engine
 * Реалізує:
 * 1. 4-смугову частотну декомпозицію (Sub-Bass, Bass, Mid, High)
 * 2. Асиметричний Attack/Release Envelope Follower (миттєва атака, пружний спад)
 * 3. Spectral Flux Onset Detection (виявлення транзиєнтів / ударів бочки)
 * 4. Auto-Gain Control (AGC — автоматична нормалізація під гучність кімнати)
 * 5. IOI BPM Tracker & Phase-Locked Beat Oscillator (фаза 0..1 та авто-темп)
 * 6. Вбудований Web Audio API техно-синтезатор (для живого тесту зі смартфона зі звуком!)
 */
class DSPEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.sourceNode = null;
    this.mediaStream = null;
    this.audioElement = null;

    this.fftSize = 1024;
    this.freqData = new Uint8Array(this.fftSize / 2);
    this.prevFreqData = new Float32Array(this.fftSize / 2);
    this.waveData = new Uint8Array(this.fftSize / 2);

    this.activeSource = "synth"; // 'synth' | 'mic' | 'screen' | 'file' | 'remote'
    this.isRunning = false;

    // Пружні огинаючі (Envelopes 0..1)
    this.envelopes = {
      subBass: 0,
      bass: 0,
      mid: 0,
      high: 0,
      energy: 0,
    };

    // Auto-Gain Control (AGC)
    this.agcPeak = 120;
    this.agcNoiseFloor = 8;

    // Spectral Flux та детектор біту
    this.fluxHistory = new Float32Array(43); // ~0.7 сек при 60fps
    this.fluxIndex = 0;
    this.lastBeatTime = 0;
    this.beatIntervals = [];
    this.bpm = 128;
    this.beatCount = 0;
    this.beatPhase = 0;
    this.isBeat = false;
    this.beatIntensity = 0;

    // Вбудований техно-синтезатор (128 BPM)
    this.synthTimer = null;
    this.synthStep = 0;
    this.synthMuted = false;

    // Дані від віддаленого смартфона-сенсора
    this.remoteTelemetry = null;
    this.targetRemote = null;
    this.lastRemoteTelemetryTime = 0;
    this.hasNativeAndroidBins = false;

    // Чутливість та підсилювач мікрофона (для захоплення звуку в приміщенні)
    this.micSensitivity = 2.5;
    this.micGainNode = null;
  }

  async start(sourceType = "synth", file = null) {
    this.stop();
    this.activeSource = sourceType;

    if (sourceType === "remote") {
      this.isRunning = true;
      return { source: "remote" };
    }

    if (sourceType === "native_android") {
      if (window.AndroidAudioBridge && window.AndroidAudioBridge.startSystemAudio) {
        window.AndroidAudioBridge.startSystemAudio();
        this.isRunning = true;
        this.lastBeatTime = performance.now();
        return { source: "native_android" };
      } else {
        throw new Error(
          "Системне захоплення YouTube Music (Visualizer API) працює у встановленому Android APK додатку на проекторі"
        );
      }
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0.45; // Низьке інерційне згладжування для чітких транзієнтів
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.prevFreqData = new Float32Array(this.analyser.frequencyBinCount);
    this.waveData = new Uint8Array(this.analyser.frequencyBinCount);

    if (sourceType === "mic") {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      this.mediaStream = stream;

      // Підсилювач чутливості мікрофона
      this.micGainNode = this.ctx.createGain();
      this.micGainNode.gain.value = this.micSensitivity || 2.5;

      this.sourceNode = this.ctx.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.micGainNode);
      this.micGainNode.connect(this.analyser);

      // КРИТИЧНО ДЛЯ iOS SAFARI: WebKit не качає аудіо-семпли в AnalyserNode,
      // якщо немає зв'язку з ctx.destination! Підключаємо через нульовий Gain:
      const zeroGain = this.ctx.createGain();
      zeroGain.gain.value = 0.0;
      this.analyser.connect(zeroGain);
      zeroGain.connect(this.ctx.destination);

      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }

      // Калібрування AGC спеціально під мікрофон смартфона
      this.agcPeak = 45;
      this.agcNoiseFloor = 4;
    } else if (sourceType === "screen") {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Захоплення екрана не підтримується в цьому браузері");
      }
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        systemAudio: "include",
      });
      const audioTracks = this.mediaStream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error("Не вибрано галочку «Надати доступ до аудіо вкладки»");
      }
      this.sourceNode = this.ctx.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.analyser);
    } else if (sourceType === "file" && file) {
      const url = URL.createObjectURL(file);
      this.audioElement = new Audio(url);
      this.audioElement.loop = true;
      this.audioElement.crossOrigin = "anonymous";
      await this.audioElement.play();
      this.sourceNode = this.ctx.createMediaElementSource(this.audioElement);
      this.sourceNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } else {
      // Вбудований Web Audio генератор клубного біту (128 BPM)
      this.startBuiltInSynth();
    }

    this.isRunning = true;
    this.lastBeatTime = performance.now();
    return { source: sourceType };
  }

  /**
   * Вбудований процедурний синтезатор (Kick + Acid Bass + Hi-Hat + Clap)
   * Дозволяє одразу почути та побачити ідеальну синхронізацію зі смартфона!
   */
  startBuiltInSynth() {
    const masterGain = this.ctx.createGain();
    masterGain.gain.value = this.synthMuted ? 0.001 : 0.55;
    this.synthGainNode = masterGain;

    // Підключаємо в аналізатор ДО регулятора звуку, щоб навіть у Mute візуалізація працювала
    const analyserHub = this.ctx.createGain();
    analyserHub.gain.value = 0.9;
    analyserHub.connect(this.analyser);
    analyserHub.connect(masterGain);
    masterGain.connect(this.ctx.destination);

    const stepDurationMs = (60 / 128 / 4) * 1000; // 16-ті ноти при 128 BPM (~117ms)
    this.synthStep = 0;

    const bassNotes = [55, 55, 110, 55, 65.41, 55, 82.41, 73.42];

    const triggerStep = () => {
      if (!this.ctx || this.ctx.state !== "running") return;
      const now = this.ctx.currentTime;
      const step = this.synthStep % 16;

      // 1. Punchy 909 Kick на кожен 0, 4, 8, 12 крок
      if (step % 4 === 0) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(42, now + 0.09);
        osc.frequency.exponentialRampToValueAtTime(28, now + 0.28);

        gain.gain.setValueAtTime(1.0, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

        osc.connect(gain);
        gain.connect(analyserHub);
        osc.start(now);
        osc.stop(now + 0.33);
      }

      // 2. Clap / Snare на 4 та 12 крок
      if (step === 4 || step === 12) {
        const bufferSize = this.ctx.sampleRate * 0.14;
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          output[i] = Math.random() * 2 - 1;
        }
        const noise = this.ctx.createBufferSource();
        noise.buffer = noiseBuffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 1400;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.14);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(analyserHub);
        noise.start(now);
      }

      // 3. Crisp Hi-Hat на непарних кроках
      if (step % 2 === 1 || step === 14) {
        const bufferSize = this.ctx.sampleRate * 0.05;
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          output[i] = Math.random() * 2 - 1;
        }
        const noise = this.ctx.createBufferSource();
        noise.buffer = noiseBuffer;

        const hp = this.ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 7000;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(step % 4 === 2 ? 0.35 : 0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

        noise.connect(hp);
        hp.connect(gain);
        gain.connect(analyserHub);
        noise.start(now);
      }

      // 4. Off-beat Cyberpunk Acid Bassline
      if (step % 2 === 1 || step === 6 || step === 14) {
        const osc = this.ctx.createOscillator();
        const filter = this.ctx.createBiquadFilter();
        const gain = this.ctx.createGain();

        osc.type = "sawtooth";
        const freq = bassNotes[Math.floor(step / 2) % bassNotes.length];
        osc.frequency.setValueAtTime(freq, now);

        filter.type = "lowpass";
        filter.Q.value = 8;
        filter.frequency.setValueAtTime(1800, now);
        filter.frequency.exponentialRampToValueAtTime(180, now + 0.11);

        gain.gain.setValueAtTime(0.38, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(analyserHub);
        osc.start(now);
        osc.stop(now + 0.12);
      }

      this.synthStep++;
    };

    triggerStep();
    this.synthTimer = setInterval(triggerStep, stepDurationMs);
  }

  setSynthMute(muted) {
    this.synthMuted = muted;
    if (this.synthGainNode && this.ctx) {
      this.synthGainNode.gain.setTargetAtTime(
        muted ? 0.0001 : 0.55,
        this.ctx.currentTime,
        0.03
      );
    }
  }

  setMicGain(multiplier = 2.5) {
    this.micSensitivity = multiplier;
    if (this.micGainNode && this.ctx && this.ctx.state !== "closed") {
      this.micGainNode.gain.setTargetAtTime(multiplier, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Прийом аудіо-телеметрії з пульта смартфона (компактний масив або об'єкт)
   */
  ingestRemoteTelemetry(packet) {
    if (!packet) return;
    this.lastRemoteTelemetryTime = performance.now();
    this.activeSource = "remote";
    this.isRunning = true;

    if (Array.isArray(packet)) {
      this.targetRemote = {
        subBass: packet[0] || 0,
        bass: packet[1] || 0,
        mid: packet[2] || 0,
        high: packet[3] || 0,
        beatIntensity: packet[4] || 0,
        bpm: packet[5] || 128,
        beatPhase: packet[6] || 0,
        isBeat: !!packet[7],
      };
    } else {
      this.targetRemote = {
        subBass: packet.subBass || 0,
        bass: packet.bass || 0,
        mid: packet.mid || 0,
        high: packet.high || 0,
        beatIntensity: packet.beatIntensity || 0,
        bpm: packet.bpm || 128,
        beatPhase: packet.beatPhase || 0,
        isBeat: !!packet.isBeat,
      };
    }

    if (this.targetRemote.isBeat) {
      this.beatCount++;
      this.isBeat = true;
      this.beatIntensity = 1.0;
    }
  }

  /**
   * Прийом системних FFT-бінів напряму з Android Visualizer(0) API (YouTube Music / Cast)
   */
  ingestNativeAndroidBins(binsArray) {
    if (!binsArray) return;
    const len = Math.min(this.freqData.length, binsArray.length);
    for (let i = 0; i < len; i++) {
      this.freqData[i] = binsArray[i];
    }
    this.hasNativeAndroidBins = true;
  }

  /**
   * Головний цикл DSP-обробки на кожному кадрі (60-120 FPS)
   */
  update(now = performance.now()) {
    // 1. Якщо джерело — віддалений смартфон (P2P або Хмара): 60 FPS плавна інтерполяція (lerp)
    if (this.activeSource === "remote" && this.targetRemote) {
      if (now - this.lastRemoteTelemetryTime > 2500) {
        return this.getEmptyState();
      }

      // Плавне підтягування значень між мережевими пакетами
      const lerp = 0.45;
      this.envelopes.subBass += (this.targetRemote.subBass - this.envelopes.subBass) * lerp;
      this.envelopes.bass += (this.targetRemote.bass - this.envelopes.bass) * lerp;
      this.envelopes.mid += (this.targetRemote.mid - this.envelopes.mid) * lerp;
      this.envelopes.high += (this.targetRemote.high - this.envelopes.high) * lerp;
      this.beatIntensity = Math.max(
        this.beatIntensity * 0.86,
        this.targetRemote.beatIntensity
      );
      this.targetRemote.beatIntensity *= 0.86;

      const energy =
        (this.envelopes.subBass +
          this.envelopes.bass +
          this.envelopes.mid +
          this.envelopes.high) /
        4;

      const hitBeat = this.isBeat;
      this.isBeat = false; // Скидаємо удар після 1 кадру рендеру

      return {
        subBass: this.envelopes.subBass,
        bass: this.envelopes.bass,
        mid: this.envelopes.mid,
        high: this.envelopes.high,
        energy,
        isBeat: hitBeat,
        beatIntensity: this.beatIntensity,
        beatCount: this.beatCount,
        bpm: this.targetRemote.bpm,
        beatPhase: this.targetRemote.beatPhase,
        freqData: this.freqData,
        waveData: this.waveData,
      };
    }

    if (this.activeSource === "native_android") {
      if (!this.hasNativeAndroidBins) return this.getEmptyState();
    } else {
      if (!this.analyser || !this.isRunning) {
        return this.getEmptyState();
      }
      this.analyser.getByteFrequencyData(this.freqData);
      this.analyser.getByteTimeDomainData(this.waveData);
    }

    const sampleRate = this.ctx ? this.ctx.sampleRate : 44100;
    const binHz = sampleRate / this.fftSize; // ~43.06 Гц на 1 бін при 1024

    // Індекси частотних смуг
    const subBassEnd = Math.max(3, Math.round(115 / binHz));
    const bassEnd = Math.max(subBassEnd + 2, Math.round(320 / binHz));
    const midEnd = Math.max(bassEnd + 4, Math.round(2800 / binHz));
    const highEnd = Math.min(this.freqData.length - 1, Math.round(13000 / binHz));

    const rawSub = this.bandAverage(1, subBassEnd);
    const rawBass = this.bandAverage(subBassEnd, bassEnd);
    const rawMid = this.bandAverage(bassEnd, midEnd);
    const rawHigh = this.bandAverage(midEnd, highEnd);

    // 1. Auto-Gain Control (AGC) — швидка й плавна адаптація до гучності кімнати
    const currentMax = Math.max(rawSub, rawBass, rawMid, rawHigh);
    if (currentMax > this.agcPeak) {
      this.agcPeak = this.agcPeak * 0.9 + currentMax * 0.1;
    } else {
      const decay = this.activeSource === "mic" ? 0.992 : 0.9985;
      const minPeak = this.activeSource === "mic" ? 28 : 55;
      this.agcPeak = Math.max(minPeak, this.agcPeak * decay);
    }

    const norm = (val) => {
      const cleaned = Math.max(0, val - this.agcNoiseFloor);
      const denominator = Math.max(22, this.agcPeak - this.agcNoiseFloor);
      return Math.min(1.0, cleaned / denominator);
    };

    const targetSub = Math.pow(norm(rawSub), this.activeSource === "mic" ? 1.15 : 1.25);
    const targetBass = norm(rawBass);
    const targetMid = norm(rawMid);
    const targetHigh = Math.min(1.0, norm(rawHigh) * 1.35);

    // 2. Асиметричний Attack / Release фільтр огинаючої
    const smooth = (curr, target, attack = 0.65, release = 0.12) =>
      target > curr ? curr + (target - curr) * attack : curr + (target - curr) * release;

    this.envelopes.subBass = smooth(this.envelopes.subBass, targetSub, 0.78, 0.14);
    this.envelopes.bass = smooth(this.envelopes.bass, targetBass, 0.6, 0.12);
    this.envelopes.mid = smooth(this.envelopes.mid, targetMid, 0.5, 0.15);
    this.envelopes.high = smooth(this.envelopes.high, targetHigh, 0.7, 0.22);
    this.envelopes.energy =
      this.envelopes.subBass * 0.45 +
      this.envelopes.bass * 0.25 +
      this.envelopes.mid * 0.2 +
      this.envelopes.high * 0.1;

    // 3. Spectral Flux Onset Detection (Тільки низькі + ударні частоти)
    let lowFlux = 0;
    for (let i = 1; i <= bassEnd; i++) {
      const diff = this.freqData[i] - this.prevFreqData[i];
      if (diff > 0) {
        lowFlux += diff * (i <= subBassEnd ? 2.2 : 1.0);
      }
    }
    for (let i = 0; i < this.freqData.length; i++) {
      this.prevFreqData[i] = this.freqData[i];
    }

    this.fluxHistory[this.fluxIndex] = lowFlux;
    this.fluxIndex = (this.fluxIndex + 1) % this.fluxHistory.length;

    let avgFlux = 0;
    for (let i = 0; i < this.fluxHistory.length; i++) {
      avgFlux += this.fluxHistory[i];
    }
    avgFlux /= this.fluxHistory.length;

    const timeSinceLastBeat = now - this.lastBeatTime;
    const fluxMult = this.activeSource === "mic" ? 1.25 : 1.48;
    const fluxThreshold = Math.max(this.activeSource === "mic" ? 24 : 45, avgFlux * fluxMult);
    const subThreshold = this.activeSource === "mic" ? 0.20 : 0.32;

    this.isBeat = false;
    if (
      lowFlux > fluxThreshold &&
      this.envelopes.subBass > subThreshold &&
      timeSinceLastBeat > 240 // Макс ~250 BPM захисту від подвійного спрацювання
    ) {
      this.isBeat = true;
      this.beatIntensity = 1.0;
      this.beatCount++;

      // 4. IOI BPM Tracker (Медіанний інтервал між ударами)
      if (timeSinceLastBeat > 280 && timeSinceLastBeat < 1100) {
        this.beatIntervals.push(timeSinceLastBeat);
        if (this.beatIntervals.length > 12) {
          this.beatIntervals.shift();
        }
        const sorted = [...this.beatIntervals].sort((a, b) => a - b);
        const medianInterval = sorted[Math.floor(sorted.length / 2)];
        const rawBpm = Math.round(60000 / medianInterval);
        if (rawBpm >= 70 && rawBpm <= 180) {
          this.bpm = Math.round(this.bpm * 0.8 + rawBpm * 0.2);
        }
      }
      this.lastBeatTime = now;
    } else {
      this.beatIntensity *= 0.86;
    }

    // 5. Phase-Locked Oscillator (0.0 -> 1.0 у темпі BPM)
    const beatPeriodMs = 60000 / (this.bpm || 128);
    this.beatPhase = ((now - this.lastBeatTime) % beatPeriodMs) / beatPeriodMs;

    return {
      subBass: this.envelopes.subBass,
      bass: this.envelopes.bass,
      mid: this.envelopes.mid,
      high: this.envelopes.high,
      energy: this.envelopes.energy,
      isBeat: this.isBeat,
      beatIntensity: this.beatIntensity,
      beatCount: this.beatCount,
      bpm: this.bpm,
      beatPhase: this.beatPhase,
      freqData: this.freqData,
      waveData: this.waveData,
    };
  }

  bandAverage(startBin, endBin) {
    let sum = 0;
    let count = 0;
    for (let i = startBin; i <= endBin && i < this.freqData.length; i++) {
      sum += this.freqData[i];
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  getEmptyState() {
    return {
      subBass: 0.05,
      bass: 0.05,
      mid: 0.05,
      high: 0.05,
      energy: 0.05,
      isBeat: false,
      beatIntensity: 0,
      beatCount: 0,
      bpm: 128,
      beatPhase: (performance.now() % 468) / 468,
      freqData: this.freqData,
      waveData: this.waveData,
    };
  }

  stop() {
    this.isRunning = false;
    this.micGainNode = null;
    if (this.synthTimer) {
      clearInterval(this.synthTimer);
      this.synthTimer = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement = null;
    }
    if (this.ctx && this.ctx.state !== "closed") {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

window.DSPEngine = DSPEngine;
