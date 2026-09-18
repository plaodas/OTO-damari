const SETTLE_SECONDS = 30;
const BREATHE_SECONDS = 120;
const RELEASE_SECONDS = 30;
const CYCLE_SECONDS = 10;
const EXPAND_SECONDS = 4;
const MIC_GATE_MS = 2200;

function smoothstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export class GuidedRestSession {
  constructor() {
    this.duration = SETTLE_SECONDS + BREATHE_SECONDS + RELEASE_SECONDS;
    this.elapsed = 0;
    this.phase = "idle";
    this.active = false;
    this.paused = false;
    this.respondedCycle = -1;
    this.micGateUntil = 0;
  }

  start() {
    this.elapsed = 0;
    this.phase = "settle";
    this.active = true;
    this.paused = false;
    this.respondedCycle = -1;
    this.micGateUntil = 0;
  }

  stop() {
    this.active = false;
    this.paused = false;
    this.phase = "idle";
    this.micGateUntil = 0;
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
  }

  update(deltaSeconds) {
    if (!this.active || this.paused) return false;
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, deltaSeconds));

    if (this.elapsed < SETTLE_SECONDS) {
      this.phase = "settle";
    } else if (this.elapsed < SETTLE_SECONDS + BREATHE_SECONDS) {
      this.phase = "breathe";
    } else if (this.elapsed < this.duration) {
      this.phase = "release";
    } else {
      this.phase = "complete";
      this.active = false;
      return true;
    }
    return false;
  }

  get cycleIndex() {
    return Math.floor(this.elapsed / CYCLE_SECONDS);
  }

  get cycleTime() {
    return this.elapsed % CYCLE_SECONDS;
  }

  get breathAmount() {
    if (this.cycleTime < EXPAND_SECONDS) {
      return smoothstep(this.cycleTime / EXPAND_SECONDS);
    }
    return 1 - smoothstep((this.cycleTime - EXPAND_SECONDS) / (CYCLE_SECONDS - EXPAND_SECONDS));
  }

  get breathMotion() {
    return this.cycleTime < EXPAND_SECONDS ? 1 : -0.7;
  }

  get guideStrength() {
    if (this.phase === "settle") return smoothstep(this.elapsed / SETTLE_SECONDS);
    if (this.phase === "breathe") return 1;
    if (this.phase === "release") {
      return 1 - smoothstep(
        (this.elapsed - SETTLE_SECONDS - BREATHE_SECONDS) / RELEASE_SECONDS,
      );
    }
    return 0;
  }

  get progress() {
    return Math.max(0, Math.min(1, this.elapsed / this.duration));
  }

  acceptsBreath(energy, level, nowMs = performance.now()) {
    if (
      !this.active ||
      this.paused ||
      this.phase !== "breathe" ||
      this.cycleTime < EXPAND_SECONDS + 0.45 ||
      nowMs < this.micGateUntil ||
      this.respondedCycle === this.cycleIndex
    ) {
      return false;
    }

    if (level < 1 && energy < 0.08) return false;
    this.respondedCycle = this.cycleIndex;
    this.micGateUntil = nowMs + MIC_GATE_MS;
    return true;
  }
}
