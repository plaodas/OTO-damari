import particleVertSource from "./shaders/particle.vert.glsl?raw";
import particleFragSource from "./shaders/particle.frag.glsl?raw";
import particleQuadVertSource from "./shaders/particle-quad.vert.glsl?raw";
import particleQuadFragSource from "./shaders/particle-quad.frag.glsl?raw";
import trailVertSource from "./shaders/trail.vert.glsl?raw";
import trailFragSource from "./shaders/trail.frag.glsl?raw";
import particleUpdateVertSource from "./shaders/particle-update.vert.glsl?raw";
import emptyFragSource from "./shaders/empty.frag.glsl?raw";
import quadVertSource from "./shaders/quad.vert.glsl?raw";
import splatFragSource from "./shaders/fluid/splat.frag.glsl?raw";
import advectFragSource from "./shaders/fluid/advect.frag.glsl?raw";
import divergenceFragSource from "./shaders/fluid/divergence.frag.glsl?raw";
import jacobiFragSource from "./shaders/fluid/jacobi.frag.glsl?raw";
import subtractFragSource from "./shaders/fluid/subtract.frag.glsl?raw";
import funnelFragSource from "./shaders/fluid/funnel.frag.glsl?raw";
import { createNoiseTexture, createProgram } from "./gl.js";
import { adaptQuality, detectQuality } from "./quality.js";
import { VelocityField } from "./fluid.js";
import { ParticleField } from "./particles.js";

const GRAIN_VOICES = 3;

const LEVEL_ENTER = [0, 0.012, 0.032, 0.07];
const LEVEL_EXIT = [0, 0.008, 0.024, 0.05];

const canvas = document.querySelector("#scene");

class MicInput {
  constructor() {
    this.analyser = null;
    this.samples = null;
    this.stream = null;
    this.startPromise = null;
    this.rms = 0;
    this.energy = 0;
    this.level = 0;
    this.noiseFloor = 0.006;
    this.debugLevel = null;
  }

  start(audioContext) {
    if (this.startPromise) return this.startPromise;

    this.startPromise = navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        this.stream = stream;
        const source = audioContext.createMediaStreamSource(stream);
        this.analyser = audioContext.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0;
        this.samples = new Float32Array(this.analyser.fftSize);
        source.connect(this.analyser);
      })
      .catch((error) => {
        console.warn("マイクを開始できませんでした。タップ操作のみで続行します。", error);
      });

    return this.startPromise;
  }

  classify(signal) {
    if (this.level === 3) {
      if (signal >= LEVEL_EXIT[3]) return 3;
    } else if (signal >= LEVEL_ENTER[3]) {
      return 3;
    }

    if (this.level === 2) {
      if (signal >= LEVEL_EXIT[2]) return 2;
    } else if (signal >= LEVEL_ENTER[2]) {
      return 2;
    }

    if (this.level === 1) {
      if (signal >= LEVEL_EXIT[1]) return 1;
    } else if (signal >= LEVEL_ENTER[1]) {
      return 1;
    }

    return 0;
  }

  update() {
    if (this.debugLevel != null) {
      this.level = this.debugLevel;
      this.energy += (this.level / 3 - this.energy) * 0.2;
      return;
    }

    if (!this.analyser) return;

    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i += 1) {
      sum += this.samples[i] * this.samples[i];
    }

    const rawRms = Math.sqrt(sum / this.samples.length);
    const attack = rawRms > this.rms ? 0.2 : 0.07;
    this.rms += (rawRms - this.rms) * attack;

    if (this.rms < 0.025) {
      this.noiseFloor += (this.rms - this.noiseFloor) * 0.004;
    }

    const signal = Math.max(0, this.rms - this.noiseFloor * 1.35);
    this.energy += (Math.min(1, signal / 0.09) - this.energy) * 0.12;
    this.level = this.classify(signal);
  }
}

class HybridSynth {
  constructor() {
    this.context = null;
    this.master = null;
    this.highpass = null;
    this.compressor = null;
    this.noiseBuffer = null;
    this.grain = null;
    this.grainAhead = 0;
    this.grainVoice = 0;
  }

  unlock() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;

      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.gain.value = 0.72;

      this.highpass = this.context.createBiquadFilter();
      this.highpass.type = "highpass";
      this.highpass.frequency.value = 180;
      this.highpass.Q.value = 0.7;

      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.12;

      this.master.connect(this.highpass);
      this.highpass.connect(this.compressor);
      this.compressor.connect(this.context.destination);
      this.noiseBuffer = this.createNoiseBuffer();
    }

    if (this.context.state === "suspended") {
      this.context.resume().catch(() => {});
    }
    return this.context;
  }

  createNoiseBuffer() {
    const length = Math.floor(this.context.sampleRate * 0.45);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  createPanner() {
    if (this.context.createStereoPanner) return this.context.createStereoPanner();
    return null;
  }

  playEnvelope(gainNode, startAt, peak, decay) {
    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), startAt + 0.002);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + decay);
  }

  playPartial(startAt, frequency, peak, decay) {
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, startAt);
    this.playEnvelope(envelope, startAt, peak, decay);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(startAt);
    oscillator.stop(startAt + decay + 0.03);
  }

  playKarplus(startAt, frequency, peak, duration, options = {}) {
    if (!this.context || !this.master || !this.noiseBuffer) return;

    const burst = options.burst ?? 0.008;
    const cutoff = options.cutoff ?? 4200;
    const feedbackAmount = options.feedback ?? 0.84;
    const delayTime = Math.max(1 / this.context.sampleRate, 1 / frequency);
    const delay = this.context.createDelay(0.05);
    const filter = this.context.createBiquadFilter();
    const feedback = this.context.createGain();
    const output = this.context.createGain();
    const noise = this.context.createBufferSource();
    const noiseGain = this.context.createGain();

    delay.delayTime.setValueAtTime(delayTime, startAt);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoff, startAt);
    filter.Q.setValueAtTime(0.707, startAt);
    feedback.gain.setValueAtTime(feedbackAmount, startAt);
    feedback.gain.setValueAtTime(feedbackAmount, startAt + duration);
    feedback.gain.linearRampToValueAtTime(0, startAt + duration + 0.03);
    noise.buffer = this.noiseBuffer;

    noiseGain.gain.setValueAtTime(Math.max(0.0002, peak), startAt);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, startAt + burst);
    output.gain.setValueAtTime(Math.max(0.0002, peak), startAt);
    output.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    noise.connect(noiseGain);
    noiseGain.connect(delay);
    delay.connect(filter);
    filter.connect(feedback);
    feedback.connect(delay);
    filter.connect(output);
    output.connect(this.master);

    noise.start(startAt);
    noise.stop(startAt + burst + 0.02);

    window.setTimeout(() => {
      feedback.gain.value = 0;
      try {
        noise.disconnect();
      } catch {
        // already disconnected
      }
      noiseGain.disconnect();
      delay.disconnect();
      filter.disconnect();
      feedback.disconnect();
      output.disconnect();
    }, (duration + 0.08) * 1000);
  }

  playChirin() {
    const context = this.unlock();
    if (!context || !this.master) return;
    const startAt = context.currentTime;
    this.playKarplus(startAt, 2200, 0.11, 0.11, {
      burst: 0.008,
      cutoff: 4500,
      feedback: 0.84,
    });
    this.playPartial(startAt, 2200, 0.032, 0.08);
    this.playPartial(startAt, 2200 * 2.11, 0.012, 0.05);
  }

  playKirari() {
    const context = this.unlock();
    if (!context || !this.master) return;
    const startAt = context.currentTime;

    this.playKarplus(startAt, 1600, 0.09, 0.14, {
      burst: 0.01,
      cutoff: 4000,
      feedback: 0.8,
    });
    this.playPartial(startAt, 1600, 0.025, 0.1);

    const carrier = context.createOscillator();
    const modulator = context.createOscillator();
    const modulation = context.createGain();
    const envelope = context.createGain();
    carrier.type = "sine";
    modulator.type = "sine";
    carrier.frequency.setValueAtTime(1600, startAt);
    modulator.frequency.setValueAtTime(800, startAt);
    modulation.gain.setValueAtTime(800 * 1.2, startAt);
    this.playEnvelope(envelope, startAt, 0.05, 0.12);
    modulator.connect(modulation);
    modulation.connect(carrier.frequency);
    carrier.connect(envelope);
    envelope.connect(this.master);
    carrier.start(startAt);
    modulator.start(startAt);
    carrier.stop(startAt + 0.15);
    modulator.stop(startAt + 0.15);

    const noise = context.createBufferSource();
    const noiseFilter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noise.buffer = this.noiseBuffer;
    noiseFilter.type = "highpass";
    noiseFilter.frequency.setValueAtTime(4200, startAt);
    this.playEnvelope(noiseGain, startAt, 0.018, 0.028);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.master);
    noise.start(startAt);
    noise.stop(startAt + 0.05);
  }

  playTap() {
    const context = this.unlock();
    if (!context || !this.master) return;
    const startAt = context.currentTime;
    const frequency = 2300 + Math.random() * 400;
    this.playKarplus(startAt, frequency, 0.08, 0.085, {
      burst: 0.006,
      cutoff: 4800,
      feedback: 0.82,
    });
    this.playPartial(startAt, frequency, 0.016, 0.045);
  }

  startShimmer() {
    const context = this.unlock();
    if (!context || !this.master || this.grain) return;

    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const voices = [];
    for (let i = 0; i < GRAIN_VOICES; i += 1) {
      const filter = context.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 3200;
      filter.Q.value = 6.5;
      const panner = this.createPanner();
      const gain = context.createGain();
      gain.gain.value = 0.0001;
      source.connect(filter);
      if (panner) {
        filter.connect(panner);
        panner.connect(gain);
      } else {
        filter.connect(gain);
      }
      gain.connect(this.master);
      voices.push({ filter, panner, gain });
    }

    source.start();
    this.grain = { source, voices, ksUntil: 8 };
    this.grainAhead = context.currentTime;
    this.grainVoice = 0;
  }

  scheduleGrains() {
    if (!this.grain || !this.context) return;

    const now = this.context.currentTime;
    const horizon = now + 0.12;
    while (this.grainAhead < horizon) {
      const time = Math.max(this.grainAhead, now);
      const voice = this.grain.voices[this.grainVoice];
      const frequency = 2500 + Math.random() * 2000;
      const peak = 0.028 + Math.random() * 0.032;
      const decay = 0.04;
      voice.filter.frequency.setValueAtTime(frequency, time);
      if (voice.panner?.pan) {
        const pan = (Math.random() - 0.5) * 1.6;
        voice.panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), time);
      }
      this.playEnvelope(voice.gain, time, peak, decay);
      this.grain.ksUntil -= 1;
      if (this.grain.ksUntil <= 0) {
        this.playKarplus(time, 1800 + Math.random() * 900, 0.02, 0.06, {
          burst: 0.005,
          cutoff: 5000,
          feedback: 0.78,
        });
        this.grain.ksUntil = 8 + Math.floor(Math.random() * 3);
      }
      this.grainVoice = (this.grainVoice + 1) % this.grain.voices.length;
      this.grainAhead = time + 0.014 + Math.random() * 0.006;
    }
  }

  stopShimmer() {
    if (!this.grain || !this.context) return;

    const { source, voices } = this.grain;
    const now = this.context.currentTime;
    for (const voice of voices) {
      voice.gain.gain.cancelScheduledValues(now);
      const current = Math.max(0.0001, voice.gain.gain.value);
      voice.gain.gain.setValueAtTime(current, now);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    }
    this.grain = null;

    window.setTimeout(() => {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      for (const voice of voices) {
        voice.filter.disconnect();
        voice.panner?.disconnect();
        voice.gain.disconnect();
      }
    }, 80);
  }
}

function showWebGLError() {
  const message = document.createElement("p");
  message.textContent = "この端末では WebGL2 が使えないため表示できません。";
  message.style.cssText =
    "position:fixed;inset:0;margin:auto;width:min(28rem,90vw);height:fit-content;color:#d7f4ff;font:1rem/1.6 sans-serif;text-align:center;";
  document.body.append(message);
}

async function start() {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: "high-performance",
  });
  if (!gl) {
    showWebGLError();
    throw new Error("WebGL2 is not available.");
  }

  const programs = {
    particle: createProgram(gl, particleVertSource, particleFragSource),
    particleQuad: createProgram(gl, particleQuadVertSource, particleQuadFragSource),
    trail: createProgram(gl, trailVertSource, trailFragSource),
    update: createProgram(gl, particleUpdateVertSource, emptyFragSource, [
      "v_position",
      "v_velocity",
    ]),
    splat: createProgram(gl, quadVertSource, splatFragSource),
    advect: createProgram(gl, quadVertSource, advectFragSource),
    divergence: createProgram(gl, quadVertSource, divergenceFragSource),
    jacobi: createProgram(gl, quadVertSource, jacobiFragSource),
    subtract: createProgram(gl, quadVertSource, subtractFragSource),
    funnel: createProgram(gl, quadVertSource, funnelFragSource),
  };
  const noiseTexture = createNoiseTexture(gl);
  const quality = detectQuality();

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.clearColor(0.006, 0.055, 0.16, 1);

  const field = new VelocityField(gl, programs, quality);
  const particles = new ParticleField(gl, programs, noiseTexture, quality);
  particles.field = field;
  const mic = new MicInput();
  const synth = new HybridSynth();
  let lastLevel = 0;

  window.__otoSetLevel = (level) => {
    mic.debugLevel = level == null ? null : Math.max(0, Math.min(3, Number(level) || 0));
  };

  function restoreViewport() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function resize() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, quality.dprCap);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    particles.resize(width, height, pixelRatio);
    field.resize(width, height);
    restoreViewport();
  }

  window.addEventListener("resize", resize, { passive: true });
  resize();

  let inputStarted = false;
  let pointer = null;

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function endPointer(event) {
    if (!pointer) return;
    if (event && pointer.id != null && event.pointerId !== pointer.id) return;
    if (pointer.swiping) {
      particles.releaseSwipe();
      if (mic.level !== 3) synth.stopShimmer();
    }
    pointer = null;
  }

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const point = localPoint(event);
    pointer = {
      id: event.pointerId,
      startX: point.x,
      startY: point.y,
      swiping: false,
    };
    particles.impact(point.x, point.y);
    canvas.setPointerCapture?.(event.pointerId);

    const context = synth.unlock();
    synth.playTap();
    if (!inputStarted && context && navigator.mediaDevices?.getUserMedia) {
      inputStarted = true;
      mic.start(context);
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    event.preventDefault();
    const point = localPoint(event);
    const distance = Math.hypot(point.x - pointer.startX, point.y - pointer.startY);
    if (!pointer.swiping && distance > 28) {
      pointer.swiping = true;
      particles.beginSwipe(pointer.startX, pointer.startY, point.x, point.y);
      synth.unlock();
      synth.playKirari();
      if (mic.level !== 3) synth.startShimmer();
    }
    if (pointer.swiping) particles.steerSwipe(point.x, point.y);
  });

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  let previousTime = performance.now();
  const startedAt = previousTime;
  function frame(now) {
    const rawDelta = (now - previousTime) / 1000;
    const deltaSeconds = Math.min(rawDelta, 0.033);
    const elapsedSeconds = (now - startedAt) / 1000;
    previousTime = now;

    mic.update();
    if (mic.level !== lastLevel) {
      if (mic.level === 3) synth.startShimmer();
      else synth.stopShimmer();

      if (mic.level > lastLevel) {
        if (mic.level === 1) {
          synth.playChirin();
          particles.pulse("weak");
        } else if (mic.level === 2) {
          synth.playKirari();
          particles.pulse("medium");
        } else if (mic.level === 3) {
          particles.pulse("strong");
        }
      }
      lastLevel = mic.level;
    }
    if (mic.level === 3) synth.scheduleGrains();

    particles.update(deltaSeconds, elapsedSeconds, mic.energy, mic.level);
    if (adaptQuality(quality, rawDelta * 1000, field, particles) && field.enabled) {
      field.resize(particles.width, particles.height);
    }
    restoreViewport();

    gl.clear(gl.COLOR_BUFFER_BIT);
    particles.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.warn("Service Worker を登録できませんでした。", error);
  });
}

start().catch((error) => {
  window.__otoStartError = String(error && error.stack ? error.stack : error);
  console.error("OTO溜まりを開始できませんでした。", error);
});
