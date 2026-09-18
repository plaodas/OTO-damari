const SETTLE_SECONDS = 30;
const BREATHE_SECONDS = 120;
const RELEASE_SECONDS = 30;
const CYCLE_SECONDS = 10;
const EXPAND_SECONDS = 4;
const BREATH_ENTER = 0.08;
const BREATH_HOLD = 0.045;

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
    this.breathing = false;
  }

  start() {
    this.elapsed = 0;
    this.phase = "settle";
    this.active = true;
    this.paused = false;
    this.breathing = false;
  }

  stop() {
    this.active = false;
    this.paused = false;
    this.phase = "idle";
    this.breathing = false;
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

  isExhaleWindow() {
    return this.phase === "breathe" && this.cycleTime >= EXPAND_SECONDS + 0.35;
  }

  updateBreath(energy, level) {
    const strong = level >= 1 || energy >= BREATH_ENTER;
    const present = level >= 1 || energy >= BREATH_HOLD;
    const canStart =
      this.active && !this.paused && this.isExhaleWindow() && strong && !this.breathing;

    if (canStart) {
      this.breathing = true;
      return { started: true, holding: true, stopped: false };
    }

    if (this.breathing && this.active && !this.paused && present) {
      return { started: false, holding: true, stopped: false };
    }

    const stopped = this.breathing;
    this.breathing = false;
    return { started: false, holding: false, stopped };
  }
}
