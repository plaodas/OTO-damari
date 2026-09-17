import particleVertSource from "./shaders/particle.vert.glsl?raw";
import particleFragSource from "./shaders/particle.frag.glsl?raw";
import trailVertSource from "./shaders/trail.vert.glsl?raw";
import trailFragSource from "./shaders/trail.frag.glsl?raw";

const PARTICLE_COUNT = 360;
const FLOATS_PER_PARTICLE = 4;
const FLOATS_PER_TRAIL_VERTEX = 3;
const GRAIN_VOICES = 3;
const TAU = Math.PI * 2;

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

class ParticleField {
  constructor(gl, particleProgram, trailProgram) {
    this.gl = gl;
    this.particleProgram = particleProgram;
    this.trailProgram = trailProgram;
    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    this.particles = [];
    this.vertexData = new Float32Array(PARTICLE_COUNT * FLOATS_PER_PARTICLE);
    this.trailData = new Float32Array(PARTICLE_COUNT * 4 * FLOATS_PER_TRAIL_VERTEX);
    this.buffer = gl.createBuffer();
    this.trailBuffer = gl.createBuffer();
    this.glowPulse = 0;
    this.sizePulse = 0;
    this.waterSheen = 0;
    this.flowBoost = 0;
    this.flowSpeed = 8;
    this.trailFade = 0;
    this.bloomAge = 0;
    this.disperse = 0;
    this.didBurst = false;

    this.particleLocations = {
      position: gl.getAttribLocation(particleProgram, "a_position"),
      size: gl.getAttribLocation(particleProgram, "a_size"),
      brightness: gl.getAttribLocation(particleProgram, "a_brightness"),
      resolution: gl.getUniformLocation(particleProgram, "u_resolution"),
      pixelRatio: gl.getUniformLocation(particleProgram, "u_pixelRatio"),
      waterSheen: gl.getUniformLocation(particleProgram, "u_waterSheen"),
      noise: gl.getUniformLocation(particleProgram, "u_noise"),
    };

    this.trailLocations = {
      position: gl.getAttribLocation(trailProgram, "a_position"),
      brightness: gl.getAttribLocation(trailProgram, "a_brightness"),
      resolution: gl.getUniformLocation(trailProgram, "u_resolution"),
    };

    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      this.particles.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 7,
        vy: (Math.random() - 0.5) * 7,
        px: 0,
        py: 0,
        qx: 0,
        qy: 0,
        phase: Math.random() * TAU,
        lane: Math.random() * 2 - 1,
        homeX: Math.random(),
        homeY: Math.random(),
        size: 3 + Math.random() * 9,
        brightness: 0.35 + Math.random() * 0.65,
      });
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.trailData.byteLength, gl.DYNAMIC_DRAW);
  }

  resize(width, height, pixelRatio) {
    const oldWidth = this.width;
    const oldHeight = this.height;
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;

    for (const particle of this.particles) {
      particle.x = oldWidth === 1 ? particle.x * width : (particle.x / oldWidth) * width;
      particle.y = oldHeight === 1 ? particle.y * height : (particle.y / oldHeight) * height;
      particle.homeX =
        oldWidth === 1 ? particle.homeX * width : (particle.homeX / oldWidth) * width;
      particle.homeY =
        oldHeight === 1 ? particle.homeY * height : (particle.homeY / oldHeight) * height;
      particle.px = particle.x;
      particle.py = particle.y;
      particle.qx = particle.x;
      particle.qy = particle.y;
    }
  }

  pulse(kind) {
    if (kind === "weak") {
      this.glowPulse = 1;
      this.sizePulse = 0.85;
    } else if (kind === "medium") {
      this.glowPulse = 0.72;
      this.waterSheen = 1;
      this.flowBoost = 1;
    } else if (kind === "strong") {
      this.glowPulse = 1;
      this.flowBoost = 1.35;
      this.trailFade = 1;
      this.bloomAge = 0;
      this.disperse = 0;
      this.didBurst = false;
    }
  }

  impact(x, y) {
    for (const particle of this.particles) {
      const dx = particle.x - x;
      const dy = particle.y - y;
      const distance = Math.hypot(dx, dy);
      const radius = Math.min(this.width, this.height) * 0.34;
      if (distance > radius) continue;

      const force = (1 - distance / radius) * 240;
      const inverseDistance = 1 / Math.max(distance, 4);
      particle.vx += dx * inverseDistance * force;
      particle.vy += dy * inverseDistance * force;
    }
  }

  update(deltaSeconds, elapsedSeconds, blowEnergy, blowLevel) {
    const frames = deltaSeconds * 60;
    this.glowPulse *= Math.pow(0.92, frames);
    this.sizePulse *= Math.pow(0.94, frames);
    this.waterSheen *= Math.pow(0.96, frames);
    this.flowBoost *= Math.pow(0.97, frames);

    const flowTarget = [8, 11, 52, 132][blowLevel] + this.flowBoost * 36;
    this.flowSpeed += (flowTarget - this.flowSpeed) * Math.min(1, 0.08 * frames);
    this.trailFade =
      blowLevel === 3 ? Math.min(1, this.trailFade + deltaSeconds * 4) : this.trailFade * Math.pow(0.9, frames);

    const bloom = blowLevel === 3;
    if (bloom) {
      this.bloomAge += deltaSeconds;
      const disperseTarget = this.bloomAge < 0.7 ? 0 : Math.min(1, (this.bloomAge - 0.7) / 0.8);
      this.disperse += (disperseTarget - this.disperse) * Math.min(1, 0.14 * frames);
    } else {
      this.bloomAge = 0;
      this.disperse *= Math.pow(0.92, frames);
    }

    const gather = bloom ? 1 - this.disperse : 0;
    const centerX = this.width * 0.5;
    const throatY = this.height * 0.9;
    const damping = Math.pow(bloom && gather > 0.55 ? 0.972 : 0.965, frames);

    if (bloom && this.disperse > 0.2 && !this.didBurst) {
      this.didBurst = true;
      for (const particle of this.particles) {
        const dx = particle.x - centerX;
        const dy = particle.y - throatY;
        const len = Math.max(18, Math.hypot(dx, dy));
        particle.vx += (dx / len) * 220 + (Math.random() - 0.5) * 90;
        particle.vy += (dy / len) * 160 - 30 + (Math.random() - 0.5) * 70;
      }
    }

    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      const waveA = Math.sin(elapsedSeconds * 0.72 + particle.phase + particle.y * 0.008);
      const waveB = Math.cos(elapsedSeconds * 0.51 - particle.phase * 1.7 + particle.x * 0.006);

      if (gather > 0.02) {
        const rise = Math.max(0, Math.min(1.2, (throatY - particle.y) / Math.max(1, throatY)));
        const dx = particle.x - centerX;
        const theta = Math.atan2(dx, Math.max(12, throatY - particle.y));
        const petal = 0.86 + 0.14 * Math.pow(Math.abs(Math.cos(theta * 2.5)), 1.1);
        const tube = 0.14;
        const u = Math.max(0, (rise - tube) / (1 - tube));
        const exponent = 2.7;
        const flare = Math.pow(u, exponent);
        const flareDeriv = u <= 0 ? 0 : (exponent * Math.pow(u, exponent - 1)) / (1 - tube);
        const amp = this.width * 0.5 * petal;
        const targetX = centerX + particle.lane * (this.width * 0.028 + amp * flare);
        const dxds = particle.lane * amp * flareDeriv;
        const dyds = -throatY;
        const tanLen = Math.hypot(dxds, dyds) || 1;
        const speed = this.flowSpeed * (0.92 + rise * 0.4);
        const tx = (dxds / tanLen) * speed;
        const ty = (dyds / tanLen) * speed;
        const steer = Math.min(1, 3.4 * deltaSeconds) * gather;
        particle.vx += (tx - particle.vx) * steer;
        particle.vy += (ty - particle.vy) * steer;
        particle.vx += (targetX - particle.x) * 7 * gather * deltaSeconds;
        particle.vx += waveA * 4 * gather * deltaSeconds;
        particle.vy += waveB * 3 * gather * deltaSeconds;
        if (rise > 0.5) {
          const lip = Math.min(1, (rise - 0.5) / 0.5);
          const curl = lip * lip * (3 - 2 * lip) * gather;
          particle.vx += particle.lane * this.flowSpeed * 1.15 * curl * deltaSeconds;
          particle.vy += this.flowSpeed * 0.72 * curl * deltaSeconds;
        }
      }

      const spread = bloom ? this.disperse : 1;
      if (spread > 0.02) {
        const homePull = bloom ? 1.15 * this.disperse : 0.22;
        particle.vx += (waveA * 7 + this.flowSpeed * 0.28 * (bloom ? 0.35 : 1)) * spread * deltaSeconds;
        particle.vy += (waveB * 7 - this.flowSpeed * 0.35 * (bloom ? 0.2 : 1)) * spread * deltaSeconds;
        particle.vx += (particle.homeX - particle.x) * homePull * deltaSeconds;
        particle.vy += (particle.homeY - particle.y) * homePull * deltaSeconds;
      }

      particle.vx *= damping;
      particle.vy *= damping;
      particle.x += particle.vx * deltaSeconds;
      particle.y += particle.vy * deltaSeconds;

      const margin = particle.size * 2;
      let wrapped = false;
      const recycleFunnel = bloom && this.disperse < 0.42;
      if (recycleFunnel) {
        const offTop = particle.y < -margin;
        const offSide = particle.x < -margin || particle.x > this.width + margin;
        if (offTop || offSide) {
          particle.x = centerX + (Math.random() - 0.5) * this.width * 0.07;
          particle.y = throatY + Math.random() * this.height * 0.05;
          particle.vx = particle.lane * 12;
          particle.vy = -this.flowSpeed * 0.55;
          wrapped = true;
        } else if (particle.y > this.height + margin) {
          particle.y = throatY;
          particle.x = centerX + (Math.random() - 0.5) * this.width * 0.06;
          wrapped = true;
        }
      } else {
        if (particle.x < -margin) {
          particle.x = this.width + margin;
          wrapped = true;
        } else if (particle.x > this.width + margin) {
          particle.x = -margin;
          wrapped = true;
        }
        if (particle.y < -margin) {
          particle.y = this.height + margin;
          wrapped = true;
        } else if (particle.y > this.height + margin) {
          particle.y = -margin;
          wrapped = true;
        }
      }

      if (wrapped) {
        particle.px = particle.x;
        particle.py = particle.y;
        particle.qx = particle.x;
        particle.qy = particle.y;
      } else {
        const followHead = 1 - Math.pow(0.84, frames);
        const followTail = 1 - Math.pow(0.9, frames);
        particle.px += (particle.x - particle.px) * followHead;
        particle.py += (particle.y - particle.py) * followHead;
        particle.qx += (particle.px - particle.qx) * followTail;
        particle.qy += (particle.py - particle.qy) * followTail;
      }

      const size =
        particle.size * (1 + this.sizePulse * 0.5 + (blowLevel === 3 ? 0.18 : 0) + blowEnergy * 0.08);
      const brightness =
        particle.brightness *
        (0.52 + this.glowPulse * 0.95 + blowLevel * 0.12 + waveA * 0.06);

      const offset = i * FLOATS_PER_PARTICLE;
      this.vertexData[offset] = particle.x;
      this.vertexData[offset + 1] = particle.y;
      this.vertexData[offset + 2] = size;
      this.vertexData[offset + 3] = brightness;

      const trailOffset = i * 4 * FLOATS_PER_TRAIL_VERTEX;
      const head = brightness * this.trailFade * 0.9;
      const mid = brightness * this.trailFade * 0.4;
      this.trailData[trailOffset] = particle.x;
      this.trailData[trailOffset + 1] = particle.y;
      this.trailData[trailOffset + 2] = head;
      this.trailData[trailOffset + 3] = particle.px;
      this.trailData[trailOffset + 4] = particle.py;
      this.trailData[trailOffset + 5] = mid;
      this.trailData[trailOffset + 6] = particle.px;
      this.trailData[trailOffset + 7] = particle.py;
      this.trailData[trailOffset + 8] = mid;
      this.trailData[trailOffset + 9] = particle.qx;
      this.trailData[trailOffset + 10] = particle.qy;
      this.trailData[trailOffset + 11] = 0;
    }
  }

  draw() {
    const gl = this.gl;
    this.drawParticles();
    if (this.trailFade > 0.04) this.drawTrails();
    gl.useProgram(this.particleProgram);
  }

  drawParticles() {
    const gl = this.gl;
    const stride = FLOATS_PER_PARTICLE * Float32Array.BYTES_PER_ELEMENT;

    gl.useProgram(this.particleProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertexData);

    gl.enableVertexAttribArray(this.particleLocations.position);
    gl.vertexAttribPointer(this.particleLocations.position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.particleLocations.size);
    gl.vertexAttribPointer(
      this.particleLocations.size,
      1,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.enableVertexAttribArray(this.particleLocations.brightness);
    gl.vertexAttribPointer(
      this.particleLocations.brightness,
      1,
      gl.FLOAT,
      false,
      stride,
      3 * Float32Array.BYTES_PER_ELEMENT,
    );

    gl.uniform2f(this.particleLocations.resolution, this.width, this.height);
    gl.uniform1f(this.particleLocations.pixelRatio, this.pixelRatio);
    gl.uniform1f(this.particleLocations.waterSheen, this.waterSheen);
    gl.uniform1i(this.particleLocations.noise, 0);
    gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);
  }

  drawTrails() {
    const gl = this.gl;
    const stride = FLOATS_PER_TRAIL_VERTEX * Float32Array.BYTES_PER_ELEMENT;

    gl.useProgram(this.trailProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.trailData);

    gl.enableVertexAttribArray(this.trailLocations.position);
    gl.vertexAttribPointer(this.trailLocations.position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.trailLocations.brightness);
    gl.vertexAttribPointer(
      this.trailLocations.brightness,
      1,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );

    gl.uniform2f(this.trailLocations.resolution, this.width, this.height);
    gl.drawArrays(gl.LINES, 0, PARTICLE_COUNT * 4);
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${message}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${message}`);
  }
  return program;
}

function createNoiseTexture(gl) {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const grain = Math.random();
      const cloudy = Math.sin(x * 0.29) * Math.cos(y * 0.23) * 0.18 + 0.5;
      const value = Math.floor(Math.max(0, Math.min(1, grain * 0.58 + cloudy * 0.42)) * 255);
      pixels[index] = value;
      pixels[index + 1] = value;
      pixels[index + 2] = value;
      pixels[index + 3] = 255;
    }
  }

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

async function start() {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL1 is not available.");

  const particleProgram = createProgram(gl, particleVertSource, particleFragSource);
  const trailProgram = createProgram(gl, trailVertSource, trailFragSource);
  createNoiseTexture(gl);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.clearColor(0.006, 0.055, 0.16, 1);

  const particles = new ParticleField(gl, particleProgram, trailProgram);
  const mic = new MicInput();
  const synth = new HybridSynth();
  let lastLevel = 0;

  window.__otoSetLevel = (level) => {
    mic.debugLevel = level == null ? null : Math.max(0, Math.min(3, Number(level) || 0));
  };

  function resize() {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    particles.resize(width, height, pixelRatio);
  }

  window.addEventListener("resize", resize, { passive: true });
  resize();

  let inputStarted = false;
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    particles.impact(event.clientX - rect.left, event.clientY - rect.top);

    const context = synth.unlock();
    synth.playTap();
    if (!inputStarted && context && navigator.mediaDevices?.getUserMedia) {
      inputStarted = true;
      mic.start(context);
    }
  });

  let previousTime = performance.now();
  const startedAt = previousTime;
  function frame(now) {
    const deltaSeconds = Math.min((now - previousTime) / 1000, 0.033);
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
  console.error("OTO溜まりを開始できませんでした。", error);
});
