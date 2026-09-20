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
import vortexFragSource from "./shaders/fluid/vortex.frag.glsl?raw";
import { createNoiseTexture, createProgram } from "./gl.js";
import { adaptQuality, detectQuality } from "./quality.js";
import { VelocityField } from "./fluid.js";
import { ParticleField } from "./particles.js";
import { estimatePhotoField } from "./photo-depth.js";
import { GuidedRestSession } from "./guided-rest.js";
import { HybridSynth, MicInput } from "./audio.js";

const MAP_NOTE_BANDS = [
  [852, 963],
  [639, 741],
  [396, 417],
  [174, 285],
];

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
const modeOverlay = document.querySelector("#mode-overlay");
const landingView = document.querySelector("#landing-view");
const completeView = document.querySelector("#complete-view");
const guidedStart = document.querySelector("#guided-start");
const freeplayStart = document.querySelector("#freeplay-start");
const completeFreeplay = document.querySelector("#complete-freeplay");
const guidedRestart = document.querySelector("#guided-restart");
const guidedExit = document.querySelector("#guided-exit");
const breathCue = document.querySelector("#breath-cue");

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
    if (delta >= 48) return 0;
    return 0.5 * (1 + Math.cos((Math.PI * delta) / 48));
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
    vortex: createProgram(gl, quadVertSource, vortexFragSource),
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
  const guidedRest = new GuidedRestSession();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let appMode = "landing";
  let lastLevel = 0;
  let northWasActive = false;
  const pointers = new Map();
  let swipePointerId = null;

  function triggerResonance(frequency) {
    if (!synth.triggerResonance(frequency)) return;
    particles.pulseResonance();
  }

  function noteAtPoint(x, y) {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const left = 16;
    const right = width - 16;
    const top = 16;
    const bottom = height - 64;
    const cx = (left + right) * 0.5;
    const cy = (top + bottom) * 0.5;
    const span = Math.max(1, Math.min(right - left, bottom - top));
    const nx = (x - cx) / span;
    const ny = (cy - y) / span;
    if (Math.abs(nx) + Math.abs(ny) < 0.22) return 528;
    const playH = Math.max(1, bottom - top);
    const v = (cy - y) / (playH * 0.5);
    const col = x < cx ? 0 : 1;
    if (v > 0.5) return MAP_NOTE_BANDS[0][col];
    if (v > 0) return MAP_NOTE_BANDS[1][col];
    if (v > -0.5) return MAP_NOTE_BANDS[2][col];
    return MAP_NOTE_BANDS[3][col];
  }

  function playMapNote(x, y) {
    triggerResonance(noteAtPoint(x, y));
  }

  motion.onShake = (amount) => {
    if (appMode !== "freeplay") return;
    particles.shake(amount);
    synth.unlock();
    triggerResonance();
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

  function stopCamera(restoreMic = true) {
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
    if (restoreMic) {
      const context = synth.unlock();
      mic.ensure(context);
    }
  }

  function setAppMode(mode) {
    if (mode !== "freeplay" && swipePointerId != null) {
      particles.releaseSwipe();
    }
    if (mode !== "freeplay") {
      pointers.clear();
      swipePointerId = null;
    }
    appMode = mode;
    document.body.classList.remove(
      "mode-landing",
      "mode-guided",
      "mode-complete",
      "mode-freeplay",
    );
    document.body.classList.add(`mode-${mode}`);
  }

  function setBreathCue(text = "", amount = 0) {
    if (breathCue.textContent !== text) breathCue.textContent = text;
    breathCue.style.opacity = String(amount);
    breathCue.setAttribute("aria-hidden", amount < 0.06 || !text ? "true" : "false");
  }

  function startGuidedRest() {
    setAppMode("guided");
    modeOverlay.hidden = true;
    landingView.hidden = false;
    completeView.hidden = true;
    guidedExit.hidden = false;
    synth.silence();
    particles.beginGuidedRest();
    guidedRest.start();
    lastLevel = 0;
    northWasActive = false;
    setBreathCue();
    const context = synth.unlock();
    if (context && navigator.mediaDevices?.getUserMedia) mic.ensure(context);
  }

  function startFreeplay() {
    guidedRest.stop();
    particles.clearGuidedBreath();
    synth.silence();
    setAppMode("freeplay");
    modeOverlay.hidden = true;
    guidedExit.hidden = true;
    canvas.focus();
    lastLevel = 0;
    northWasActive = false;
    setBreathCue();
    const context = synth.unlock();
    motion.start();
    motion.bind();
    if (context && navigator.mediaDevices?.getUserMedia) mic.ensure(context);
  }

  function finishGuidedRest() {
    if (appMode !== "guided") return;
    guidedRest.stop();
    particles.clearGuidedBreath();
    synth.silence(0.5);
    mic.debugLevel = null;
    mic.disconnect();
    setAppMode("complete");
    guidedExit.hidden = true;
    landingView.hidden = true;
    completeView.hidden = false;
    modeOverlay.hidden = false;
    setBreathCue();
    completeFreeplay.focus();
  }

  guidedStart.addEventListener("click", startGuidedRest);
  freeplayStart.addEventListener("click", startFreeplay);
  completeFreeplay.addEventListener("click", startFreeplay);
  guidedRestart.addEventListener("click", startGuidedRest);
  guidedExit.addEventListener("click", finishGuidedRest);
  document.addEventListener("visibilitychange", () => {
    guidedRest.setPaused(document.hidden);
  });

  async function openCamera() {
    if (appMode !== "freeplay") return;
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
  cameraClose.addEventListener("click", () => stopCamera());
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
      triggerResonance();
      stopCamera();
    } catch (error) {
      console.warn("写真を解析できませんでした。", error);
      cameraMessage.textContent = "写真を解析できませんでした";
      cameraShutter.disabled = false;
    } finally {
      resumeGl();
    }
  });
  window.addEventListener("pagehide", () => {
    stopCamera(false);
    guidedRest.stop();
    particles.clearGuidedBreath();
    synth.silence(0.2);
    mic.disconnect();
  });

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

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function endPointer(event) {
    if (appMode !== "freeplay") {
      pointers.clear();
      swipePointerId = null;
      return;
    }
    const id = event?.pointerId;
    const pointer = id == null ? null : pointers.get(id);
    if (!pointer) return;
    pointers.delete(id);
    if (swipePointerId === id) {
      particles.releaseSwipe();
      swipePointerId = null;
    }
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (appMode !== "freeplay") return;
    event.preventDefault();
    const point = localPoint(event);
    const note = noteAtPoint(point.x, point.y);
    pointers.set(event.pointerId, {
      startX: point.x,
      startY: point.y,
      note,
      swiping: false,
    });
    particles.impact(point.x, point.y);
    canvas.setPointerCapture?.(event.pointerId);

    const context = synth.unlock();
    motion.start();
    motion.bind();
    if (context && navigator.mediaDevices?.getUserMedia) {
      mic.ensure(context);
    }
    playMapNote(point.x, point.y);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (appMode !== "freeplay") return;
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    const point = localPoint(event);
    const distance = Math.hypot(point.x - pointer.startX, point.y - pointer.startY);
    if (!pointer.swiping && distance > 28) {
      pointer.swiping = true;
      if (swipePointerId == null) {
        swipePointerId = event.pointerId;
        particles.beginSwipe(pointer.startX, pointer.startY, point.x, point.y);
      }
    }
    if (pointer.swiping && swipePointerId === event.pointerId) {
      particles.steerSwipe(point.x, point.y);
    }
    if (pointer.swiping) {
      const note = noteAtPoint(point.x, point.y);
      if (note !== pointer.note) {
        pointer.note = note;
        playMapNote(point.x, point.y);
      }
    }
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

    let particleEnergy = 0;
    let particleLevel = 0;

    if (appMode === "guided") {
      mic.update();
      if (guidedRest.update(deltaSeconds)) finishGuidedRest();
      if (appMode === "guided") {
        particles.setTilt(0, 0, 0);
        particles.setGuidedBreath(
          guidedRest.breathAmount,
          guidedRest.breathMotion,
          guidedRest.guideStrength,
          reducedMotion.matches,
        );
        const breath = guidedRest.updateBreath(mic.energy, mic.level);
        particles.setBreathGlow(breath.holding);
        const contractTone =
          breath.started || (breath.holding && guidedRest.contractStarted);
        if (contractTone) {
          const started = synth.startGuidedTone(guidedRest.remainingContract);
          if (started && breath.started) particles.pulseResonance();
        } else if (breath.stopped) {
          synth.stopGuidedTone();
        }
        const cue = guidedRest.cue;
        setBreathCue(cue.text, cue.amount);
      }
    } else if (appMode === "freeplay") {
      particles.clearGuidedBreath();
      mic.update();
      motion.update(deltaSeconds);
      particles.setTilt(motion.tiltX, motion.tiltY, motion.north);
      if (motion.north >= 0.65 && !northWasActive) {
        northWasActive = true;
        triggerResonance();
      } else if (motion.north <= 0.25) {
        northWasActive = false;
      }
      if (mic.level !== lastLevel) {
        if (mic.level === 3 && lastLevel < 3) synth.startBlowChord();
        else if (mic.level < 3 && lastLevel === 3) synth.stopBlowChord();

        if (mic.level > lastLevel) {
          if (mic.level < 3) triggerResonance();
          if (mic.level === 1) {
            particles.pulse("weak");
          } else if (mic.level === 2) {
            particles.pulse("medium");
          } else if (mic.level === 3) {
            particles.pulse("strong");
          }
        }
        lastLevel = mic.level;
      }
      particleEnergy = mic.energy;
      particleLevel = mic.level;
    } else {
      particles.setTilt(0, 0, 0);
      particles.clearGuidedBreath();
    }

    particles.update(deltaSeconds, elapsedSeconds, particleEnergy, particleLevel);
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
