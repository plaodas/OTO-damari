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
import { estimatePhotoField } from "./photo-depth.js";

const GRAIN_VOICES = 3;

const LEVEL_ENTER = [0, 0.012, 0.032, 0.07];
const LEVEL_EXIT = [0, 0.008, 0.024, 0.05];

const canvas = document.querySelector("#scene");
const volumeControl = document.querySelector("#volume-control");
const volumeButton = document.querySelector("#volume-button");
const volumeSlider = document.querySelector("#volume-slider");
const volumeIcon = document.querySelector("#volume-icon");
const cameraButton = document.querySelector("#camera-button");
const cameraPanel = document.querySelector("#camera-panel");
const cameraPreview = document.querySelector("#camera-preview");
const cameraMessage = document.querySelector("#camera-message");
const cameraClose = document.querySelector("#camera-close");
const cameraShutter = document.querySelector("#camera-shutter");
const cameraClear = document.querySelector("#camera-clear");

function readStoredVolume() {
  try {
    const stored = Number.parseFloat(localStorage.getItem("oto-volume"));
    if (Number.isFinite(stored)) return Math.max(0, Math.min(1, stored));
  } catch {
    // Storage may be unavailable in private browsing.
  }
  return 0.85;
}

class MicInput {
  constructor() {
    this.analyser = null;
    this.samples = null;
    this.stream = null;
    this.source = null;
    this.startPromise = null;
    this.rms = 0;
    this.energy = 0;
    this.level = 0;
    this.noiseFloor = 0.006;
    this.debugLevel = null;
  }

  hasLiveTrack() {
    return Boolean(this.stream?.getAudioTracks().some((track) => track.readyState === "live"));
  }

  start(audioContext) {
    if (this.hasLiveTrack() && this.analyser) return this.startPromise || Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.startPromise = navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      .then((stream) => {
        this.disconnect();
        this.stream = stream;
        for (const track of stream.getAudioTracks()) {
          track.addEventListener("ended", () => {
            this.disconnect();
          });
        }
        this.source = audioContext.createMediaStreamSource(stream);
        this.analyser = audioContext.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0;
        this.samples = new Float32Array(this.analyser.fftSize);
        this.source.connect(this.analyser);
      })
      .catch((error) => {
        console.warn("マイクを開始できませんでした。タップ操作のみで続行します。", error);
        this.disconnect();
      })
      .finally(() => {
        this.startPromise = null;
      });

    return this.startPromise;
  }

  ensure(audioContext) {
    if (!audioContext) return Promise.resolve();
    if (this.hasLiveTrack() && this.analyser) return Promise.resolve();
    this.startPromise = null;
    return this.start(audioContext);
  }

  disconnect() {
    try {
      this.source?.disconnect();
    } catch {
      // already disconnected
    }
    this.source = null;
    this.analyser = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
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

class MotionInput {
  constructor() {
    this.tiltX = 0;
    this.tiltY = 0;
    this.started = false;
    this.bound = false;
    this.startPromise = null;
    this.lastShakeAt = 0;
    this.armedAt = 0;
    this.gravityX = 0;
    this.gravityY = 0;
    this.restX = 0;
    this.restY = 0;
    this.restReady = false;
    this.hasOrientation = false;
    this.gotRelativeOrientation = false;
    this.heading = null;
    this.sensorHeading = null;
    this.headingSensor = null;
    this.magnetometer = null;
    this.accelSensor = null;
    this.gravityRaw = null;
    this.magRaw = null;
    this.north = 0;
    this.useRelativeHeading = false;
    this.headingWatchdog = 0;
    this.motionEnergy = 0;
    this.poseDelta = 0;
    this.stillSeconds = 0;
    this.prevGravityX = 0;
    this.prevGravityY = 0;
    this.onShake = null;
    this.android = /Android/i.test(navigator.userAgent);
  }

  start() {
    this.bind();
    this.startHeadingSensor();
    this.startCompassSensors();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.enable();
    return this.startPromise;
  }

  async enable() {
    const motion = window.DeviceMotionEvent;
    const orientation = window.DeviceOrientationEvent;
    if (!motion && !orientation && typeof window.AbsoluteOrientationSensor !== "function") return;

    try {
      if (typeof motion?.requestPermission === "function") {
        const state = await motion.requestPermission();
        if (state !== "granted") {
          console.warn("モーションセンサーが許可されませんでした。");
        }
      }
      if (typeof orientation?.requestPermission === "function") {
        await orientation.requestPermission().catch(() => "denied");
      }
    } catch (error) {
      console.warn("モーションセンサーの許可を取得できませんでした。", error);
    }

    this.bind();
    this.startHeadingSensor();
    this.startCompassSensors();
    this.armRelativeHeadingFallback();
  }

  armRelativeHeadingFallback() {
    if (!this.android || this.headingWatchdog) return;
    this.headingWatchdog = window.setTimeout(() => {
      if (this.sensorHeading == null) this.useRelativeHeading = true;
    }, 1200);
  }

  allowRelativeHeading() {
    if (!this.android) return;
    this.useRelativeHeading = true;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.started = true;
    this.armedAt = performance.now() + 450;
    window.addEventListener("devicemotion", this.handleMotion, { passive: true });
    window.addEventListener("deviceorientation", this.handleOrientation, { passive: true });
    window.addEventListener("deviceorientationabsolute", this.handleAbsoluteOrientation, { passive: true });
  }

  startHeadingSensor() {
    if (this.headingSensor) return;
    const Sensor = window.AbsoluteOrientationSensor;
    if (typeof Sensor !== "function") {
      this.allowRelativeHeading();
      return;
    }
    for (const referenceFrame of ["device", "screen"]) {
      try {
        const sensor = new Sensor({ frequency: 20, referenceFrame });
        sensor.addEventListener("reading", () => {
          const heading = this.headingFromQuaternion(sensor.quaternion);
          if (heading == null) return;
          this.sensorHeading =
            referenceFrame === "screen" ? heading : (heading + this.screenAngle() + 360) % 360;
          if (this.headingWatchdog) {
            clearTimeout(this.headingWatchdog);
            this.headingWatchdog = 0;
          }
        });
        sensor.addEventListener("error", () => {
          try {
            sensor.stop();
          } catch {
            // Sensor may already be stopped.
          }
          if (this.headingSensor === sensor) this.headingSensor = null;
          this.allowRelativeHeading();
        });
        sensor.start();
        this.headingSensor = sensor;
        this.armRelativeHeadingFallback();
        return;
      } catch {
        // Try the next reference frame.
      }
    }
    this.allowRelativeHeading();
  }

  startCompassSensors() {
    if (this.magnetometer) return;
    const Mag = window.Magnetometer;
    const Accel = window.Accelerometer;
    if (typeof Mag !== "function") {
      if (!this.headingSensor) this.allowRelativeHeading();
      return;
    }
    try {
      const magnetometer = new Mag({ frequency: 20, referenceFrame: "device" });
      magnetometer.addEventListener("reading", () => {
        this.magRaw = { x: magnetometer.x, y: magnetometer.y, z: magnetometer.z };
        this.updateMagHeading();
      });
      magnetometer.addEventListener("error", () => {
        try {
          magnetometer.stop();
        } catch {
          // Already stopped.
        }
        if (this.magnetometer === magnetometer) this.magnetometer = null;
      });
      magnetometer.start();
      this.magnetometer = magnetometer;
    } catch {
      this.magnetometer = null;
      if (!this.headingSensor) this.allowRelativeHeading();
      return;
    }
    if (typeof Accel !== "function") return;
    try {
      const accel = new Accel({ frequency: 20, referenceFrame: "device" });
      accel.addEventListener("reading", () => {
        this.gravityRaw = { x: accel.x, y: accel.y, z: accel.z };
        this.updateMagHeading();
      });
      accel.addEventListener("error", () => {
        try {
          accel.stop();
        } catch {
          // Already stopped.
        }
      });
      accel.start();
      this.accelSensor = accel;
    } catch {
      this.accelSensor = null;
    }
  }

  updateMagHeading() {
    if (this.sensorHeading != null) return;
    const g = this.gravityRaw;
    const m = this.magRaw;
    if (!g || !m) return;
    const heading = this.headingFromAccelMag(g.x, g.y, g.z, m.x, m.y, m.z);
    if (heading != null) this.heading = (heading + this.screenAngle() + 360) % 360;
  }

  headingFromAccelMag(ax, ay, az, mx, my, mz) {
    const g = Math.hypot(ax, ay, az);
    if (g < 1) return null;
    ax /= g;
    ay /= g;
    az /= g;
    let hx = my * az - mz * ay;
    let hy = mz * ax - mx * az;
    let hz = mx * ay - my * ax;
    const east = Math.hypot(hx, hy, hz);
    if (east < 0.05) return null;
    hx /= east;
    hy /= east;
    hz /= east;
    const nx = ay * hz - az * hy;
    const ny = az * hx - ax * hz;
    const nz = ax * hy - ay * hx;
    return (Math.atan2(-hz, -nz) * (180 / Math.PI) + 360) % 360;
  }

  rotateVec(q, v) {
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return [
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    ];
  }

  headingFromDir(dir) {
    const horiz = Math.hypot(dir[0], dir[1]);
    if (horiz < 0.08) return null;
    return (Math.atan2(dir[0], dir[1]) * (180 / Math.PI) + 360) % 360;
  }

  headingFromQuaternion(quaternion) {
    if (!quaternion || quaternion.length < 4) return null;
    const q = [quaternion[0], quaternion[1], quaternion[2], quaternion[3]];
    const qInv = [-q[0], -q[1], -q[2], q[3]];
    let best = null;
    let bestHoriz = 0;
    for (const rot of [q, qInv]) {
      const back = this.rotateVec(rot, [0, 0, -1]);
      const top = this.rotateVec(rot, [0, 1, 0]);
      const backHoriz = Math.hypot(back[0], back[1]);
      const facing = backHoriz >= 0.35 ? back : top;
      const horiz = Math.hypot(facing[0], facing[1]);
      if (horiz <= bestHoriz) continue;
      const heading = this.headingFromDir(facing);
      if (heading == null) continue;
      best = heading;
      bestHoriz = horiz;
    }
    return best;
  }

  compassFromEuler(alpha, beta, gamma) {
    const toRad = Math.PI / 180;
    const x = beta * toRad;
    const y = gamma * toRad;
    const z = alpha * toRad;
    const cX = Math.cos(x);
    const cY = Math.cos(y);
    const cZ = Math.cos(z);
    const sX = Math.sin(x);
    const sY = Math.sin(y);
    const sZ = Math.sin(z);
    const vx = -cZ * sY - sZ * sX * cY;
    const vy = -sZ * sY + cZ * sX * cY;
    if (Math.hypot(vx, vy) < 1e-5) return (360 - alpha + 360) % 360;
    return (Math.atan2(vx, vy) * (180 / Math.PI) + 360) % 360;
  }

  screenAngle() {
    return Number(screen.orientation?.angle ?? window.orientation ?? 0);
  }

  rotateToScreen(x, y) {
    const angle = this.screenAngle();
    if (angle === 90) return { x: y, y: -x };
    if (angle === 180) return { x: -x, y: -y };
    if (angle === 270 || angle === -90) return { x: -y, y: x };
    return { x, y };
  }

  readHeading(event) {
    const screen = this.screenAngle();
    if (Number.isFinite(event.webkitCompassHeading)) {
      return (event.webkitCompassHeading + screen + 360) % 360;
    }
    if (Number.isFinite(event.compassHeading)) {
      return (event.compassHeading + screen + 360) % 360;
    }
    const relativeOk =
      this.useRelativeHeading &&
      Number.isFinite(event.alpha) &&
      Number.isFinite(event.beta) &&
      Number.isFinite(event.gamma);
    const absolute =
      event.absolute === true ||
      event.type === "deviceorientationabsolute" ||
      (this.android && event.absolute !== false) ||
      relativeOk;
    if (!absolute || !Number.isFinite(event.alpha)) return null;
    if (Number.isFinite(event.beta) && Number.isFinite(event.gamma)) {
      return (this.compassFromEuler(event.alpha, event.beta, event.gamma) + screen + 360) % 360;
    }
    return (360 - event.alpha + screen + 360) % 360;
  }

  northAlignment(heading) {
    const delta = Math.min(Math.abs(heading), 360 - Math.abs(heading));
    if (delta >= 32) return 0;
    return 0.5 * (1 + Math.cos((Math.PI * delta) / 32));
  }

  setRawTilt(x, y) {
    const clamp = (value) => Math.max(-1, Math.min(1, value));
    this.gravityX += (clamp(x) - this.gravityX) * 0.22;
    this.gravityY += (clamp(y) - this.gravityY) * 0.22;
    if (!this.restReady && performance.now() >= this.armedAt) {
      this.restX = this.gravityX;
      this.restY = this.gravityY;
      this.restReady = true;
    }
  }

  handleMotion = (event) => {
    const gravity = event.accelerationIncludingGravity;
    if (gravity && Number.isFinite(gravity.x) && Number.isFinite(gravity.y) && Number.isFinite(gravity.z)) {
      this.gravityRaw = { x: gravity.x, y: gravity.y, z: gravity.z };
      this.updateMagHeading();
    }
    if (!this.hasOrientation && gravity && Number.isFinite(gravity.x) && Number.isFinite(gravity.y)) {
      const mag = Math.hypot(gravity.x, gravity.y, gravity.z || 0);
      if (mag > 6) {
        const sign = this.android ? 1 : -1;
        const mapped = this.rotateToScreen(sign * (gravity.x / mag), sign * ((gravity.z || 0) / mag));
        this.setRawTilt(mapped.x, mapped.y);
      }
    }

    const user = event.acceleration;
    const ax = user?.x;
    const ay = user?.y;
    const az = user?.z;
    const strength =
      Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az)
        ? Math.hypot(ax, ay, az)
        : Number.isFinite(gravity?.x) && Number.isFinite(gravity?.y)
          ? Math.abs(Math.hypot(gravity.x, gravity.y, gravity.z || 0) - 9.81)
          : 0;

    const now = performance.now();
    this.motionEnergy += (Math.min(1, strength / 6) - this.motionEnergy) * 0.28;
    if (now < this.armedAt) return;
    if (strength > 13 && now - this.lastShakeAt > 480) {
      this.lastShakeAt = now;
      this.onShake?.(Math.min(1.3, (strength - 13) / 14));
    }
  };

  handleAbsoluteOrientation = (event) => {
    const heading = this.readHeading(event);
    if (heading != null) this.heading = heading;
    if (this.gotRelativeOrientation) return;
    if (!Number.isFinite(event.gamma) || !Number.isFinite(event.beta)) return;
    if (!this.hasOrientation) {
      this.restReady = false;
      this.armedAt = performance.now() + 220;
    }
    this.hasOrientation = true;
    const mapped = this.rotateToScreen(event.gamma / 32, (event.beta - 90) / 32);
    this.setRawTilt(mapped.x, mapped.y);
  };

  handleOrientation = (event) => {
    const heading = this.readHeading(event);
    if (heading != null) this.heading = heading;
    if (!Number.isFinite(event.gamma) || !Number.isFinite(event.beta)) return;
    if (!this.hasOrientation) {
      this.restReady = false;
      this.armedAt = performance.now() + 220;
    }
    this.gotRelativeOrientation = true;
    this.hasOrientation = true;
    const mapped = this.rotateToScreen(event.gamma / 32, (event.beta - 90) / 32);
    this.setRawTilt(mapped.x, mapped.y);
  };

  update(deltaSeconds = 0.016) {
    const heading = this.sensorHeading ?? this.heading;
    const northTarget = heading == null ? 0 : this.northAlignment(heading);
    this.north += (northTarget - this.north) * 0.12;

    const poseChange = Math.hypot(this.gravityX - this.prevGravityX, this.gravityY - this.prevGravityY);
    this.prevGravityX = this.gravityX;
    this.prevGravityY = this.gravityY;
    this.poseDelta += (poseChange - this.poseDelta) * 0.3;
    const still = this.motionEnergy < 0.16 && this.poseDelta < 0.01;
    this.stillSeconds = still ? this.stillSeconds + deltaSeconds : 0;

    if (!this.started || !this.restReady) {
      this.tiltX += (0 - this.tiltX) * 0.28;
      this.tiltY += (0 - this.tiltY) * 0.28;
      return;
    }

    const clamp = (value) => Math.max(-1, Math.min(1, value));
    const dx = clamp(this.gravityX - this.restX);
    const dy = clamp(this.gravityY - this.restY);
    const mag = Math.hypot(dx, dy);
    const dead = 0.26;

    if (still) {
      this.tiltX += (0 - this.tiltX) * 0.35;
      this.tiltY += (0 - this.tiltY) * 0.35;
      const catchUp = this.stillSeconds > 0.28 ? 0.28 : 0.1;
      this.restX += (this.gravityX - this.restX) * catchUp;
      this.restY += (this.gravityY - this.restY) * catchUp;
      return;
    }

    if (mag < dead) {
      this.restX += (this.gravityX - this.restX) * 0.12;
      this.restY += (this.gravityY - this.restY) * 0.12;
      this.tiltX += (0 - this.tiltX) * 0.28;
      this.tiltY += (0 - this.tiltY) * 0.28;
      return;
    }

    const gain = (mag - dead) / (1 - dead);
    const tx = (dx / mag) * gain;
    const ty = (dy / mag) * gain;
    this.tiltX += (tx - this.tiltX) * 0.22;
    this.tiltY += (ty - this.tiltY) * 0.22;
  }
}

class HybridSynth {
  constructor() {
    this.context = null;
    this.master = null;
    this.volume = readStoredVolume();
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
      this.master.gain.value = this.volume * this.volume;

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

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(
        this.volume * this.volume,
        this.context.currentTime,
        0.02,
      );
    }
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
  const motion = new MotionInput();
  let lastLevel = 0;
  motion.onShake = (amount) => {
    particles.shake(amount);
    synth.unlock();
    synth.playKirari();
  };
  let volumeCloseTimer = 0;

  function updateVolumeControl() {
    volumeSlider.value = String(synth.volume);
    volumeIcon.textContent = synth.volume < 0.01 ? "🔇" : synth.volume < 0.5 ? "🔉" : "🔊";
    volumeButton.setAttribute("aria-label", `音量を調整、現在${Math.round(synth.volume * 100)}%`);
  }

  function setVolumeControlOpen(open) {
    volumeControl.classList.toggle("is-open", open);
    volumeButton.setAttribute("aria-expanded", String(open));
  }

  function scheduleVolumeControlClose() {
    window.clearTimeout(volumeCloseTimer);
    volumeCloseTimer = window.setTimeout(() => {
      setVolumeControlOpen(false);
    }, 2800);
  }

  volumeControl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  volumeButton.addEventListener("click", () => {
    const willOpen = !volumeControl.classList.contains("is-open");
    setVolumeControlOpen(willOpen);
    if (willOpen) scheduleVolumeControlClose();
    else window.clearTimeout(volumeCloseTimer);
  });
  volumeSlider.addEventListener("input", () => {
    synth.setVolume(volumeSlider.value);
    updateVolumeControl();
    try {
      localStorage.setItem("oto-volume", String(synth.volume));
    } catch {
      // Keep the current session volume when storage is unavailable.
    }
    scheduleVolumeControlClose();
  });
  volumeSlider.addEventListener("change", scheduleVolumeControlClose);
  updateVolumeControl();

  let cameraStream = null;
  let cameraRequestId = 0;
  let glPauseCount = 0;

  function pauseGl() {
    glPauseCount += 1;
  }

  function resumeGl() {
    glPauseCount = Math.max(0, glPauseCount - 1);
  }

  function waitForEvent(target, eventName, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        target.removeEventListener(eventName, onEvent);
        resolve();
      }, timeoutMs);
      const onEvent = () => {
        clearTimeout(timer);
        target.removeEventListener(eventName, onEvent);
        resolve();
      };
      target.addEventListener(eventName, onEvent);
    });
  }

  async function waitForCameraFrame(video) {
    if (video.readyState < HTMLMediaElement.HAVE_METADATA || video.videoWidth < 2) {
      await waitForEvent(video, "loadedmetadata", 1500);
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, "loadeddata", 1500);
    }
    if (typeof video.requestVideoFrameCallback === "function") {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 400);
        video.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  function stopCamera() {
    cameraRequestId += 1;
    if (cameraStream) {
      for (const track of cameraStream.getTracks()) track.stop();
    }
    cameraStream = null;
    cameraPreview.pause();
    cameraPreview.srcObject = null;
    try {
      cameraPreview.load();
    } catch {
      // Some browsers throw if load() is called without a source.
    }
    cameraPanel.hidden = true;
    cameraShutter.disabled = true;
    const context = synth.unlock();
    mic.ensure(context);
  }

  async function openCamera() {
    const requestId = ++cameraRequestId;
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraPanel.hidden = false;
      cameraShutter.disabled = true;
      cameraMessage.textContent = "この端末ではカメラを利用できません";
      return;
    }

    cameraPanel.hidden = false;
    cameraShutter.disabled = true;
    cameraMessage.textContent = "奥行きモデルを準備しています…";
    pauseGl();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
        audio: false,
      });
      if (requestId !== cameraRequestId) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      cameraStream = stream;
      cameraPreview.srcObject = cameraStream;
      await cameraPreview.play();
      await waitForCameraFrame(cameraPreview);
      if (requestId !== cameraRequestId) return;
      const { photoModelStatus, warmupPhotoModels } = await import("./photo-ml.js");
      await warmupPhotoModels();
      if (requestId !== cameraRequestId) return;
      cameraShutter.disabled = false;
      const models = photoModelStatus();
      cameraMessage.textContent = models.depth
        ? "写真はこの端末のメモリ内だけで処理され、保存・送信されません"
        : "モデルを読めなかったため、端末内の簡易な輪郭処理で続行します";
    } catch (error) {
      if (requestId !== cameraRequestId) return;
      console.warn("カメラを開始できませんでした。", error);
      cameraMessage.textContent = "カメラを開始できませんでした";
    } finally {
      resumeGl();
    }
  }

  cameraButton.addEventListener("click", openCamera);
  cameraClose.addEventListener("click", stopCamera);
  cameraClear.addEventListener("click", () => {
    particles.clearPhotoField();
    stopCamera();
  });
  cameraShutter.addEventListener("click", async () => {
    if (!cameraStream || cameraPreview.videoWidth < 2) return;
    if (cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    cameraShutter.disabled = true;
    cameraMessage.textContent = "奥行きを読み取っています…";
    pauseGl();
    try {
      const fieldData = await estimatePhotoField(
        cameraPreview,
        window.innerWidth,
        window.innerHeight,
        particles.count,
        false,
      );
      restoreViewport();
      particles.setPhotoField(fieldData);
      synth.unlock();
      synth.playKirari();
      stopCamera();
    } catch (error) {
      console.warn("写真を解析できませんでした。", error);
      cameraMessage.textContent = "写真を解析できませんでした";
      cameraShutter.disabled = false;
    } finally {
      resumeGl();
    }
  });
  window.addEventListener("pagehide", stopCamera);

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
    motion.start();
    motion.bind();
    if (context && navigator.mediaDevices?.getUserMedia) {
      mic.ensure(context);
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
    if (glPauseCount > 0) {
      previousTime = now;
      requestAnimationFrame(frame);
      return;
    }
    const rawDelta = (now - previousTime) / 1000;
    const deltaSeconds = Math.min(rawDelta, 0.033);
    const elapsedSeconds = (now - startedAt) / 1000;
    previousTime = now;

    mic.update();
    motion.update(deltaSeconds);
    particles.setTilt(motion.tiltX, motion.tiltY, motion.north);
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
