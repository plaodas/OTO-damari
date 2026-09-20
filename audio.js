export const SOLFEGGIO_FREQUENCIES = [174, 285, 396, 417, 528, 639, 741, 852, 963];
export const LEVEL_ENTER = [0, 0.012, 0.032, 0.07];
export const LEVEL_EXIT = [0, 0.008, 0.024, 0.05];

// Raise after speaker-to-mic checks. 1 keeps the previous maximum.
const MASTER_MAX_GAIN = 1;
const RESONANCE_VOICE_LIMIT = 5;
const RESONANCE_PEAK_LOW = 0.02;
const RESONANCE_PEAK_HIGH = 0.014;
const GUIDED_PEAK_LOW = 0.022;
const GUIDED_PEAK_HIGH = 0.016;
const BLOW_CHORD_FREQUENCIES = [174, 285, 963];
const BLOW_CHORD_GAIN_LOW = 0.026;
const BLOW_CHORD_GAIN_MID = 0.016;
const BLOW_CHORD_GAIN_HIGH = 0.012;
const VOLUME_STORAGE_KEY = "oto-volume";
const DEFAULT_VOLUME = 0.85;

function readStoredVolume() {
  try {
    const stored = Number.parseFloat(localStorage.getItem(VOLUME_STORAGE_KEY));
    if (Number.isFinite(stored)) return Math.max(0, Math.min(1, stored));
  } catch {
    // Storage may be unavailable in private browsing.
  }
  return DEFAULT_VOLUME;
}

function masterGainFor(volume) {
  return volume * volume * MASTER_MAX_GAIN;
}

function blowChordGain(frequency) {
  if (frequency <= 174) return BLOW_CHORD_GAIN_LOW;
  if (frequency <= 285) return BLOW_CHORD_GAIN_MID;
  return BLOW_CHORD_GAIN_HIGH;
}

export class MicInput {
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
    this.rms = 0;
    this.energy = 0;
    this.level = 0;
    this.noiseFloor = 0.006;
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

export class HybridSynth {
  constructor() {
    this.context = null;
    this.master = null;
    this.volume = readStoredVolume();
    this.highpass = null;
    this.compressor = null;
    this.resonanceIndex = 0;
    this.resonanceVoices = [];
    this.blowChord = null;
    this.guidedTone = null;
  }

  unlock() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;

      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.gain.value = masterGainFor(this.volume);

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
        masterGainFor(this.volume),
        this.context.currentTime,
        0.02,
      );
    }
  }

  silence(release = 0.35) {
    this.stopBlowChord();
    this.stopGuidedTone();
    this.fadeAllResonances(release);
  }

  fadeResonanceVoice(voice, startAt, release = 0.08) {
    voice.gain.gain.cancelScheduledValues(startAt);
    voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), startAt);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, startAt + release);
    try {
      voice.oscillator.stop(startAt + release + 0.02);
    } catch {
      // The resonance may already have ended.
    }
  }

  fadeAllResonances(release = 0.35) {
    if (!this.context) return;
    const startAt = this.context.currentTime;
    for (const voice of this.resonanceVoices.splice(0)) {
      this.fadeResonanceVoice(voice, startAt, release);
    }
  }

  triggerResonance(frequency) {
    const context = this.unlock();
    if (!context || !this.master) return false;

    let note = Number(frequency);
    if (!Number.isFinite(note) || note <= 0) {
      note = SOLFEGGIO_FREQUENCIES[this.resonanceIndex];
      this.resonanceIndex = (this.resonanceIndex + 1) % SOLFEGGIO_FREQUENCIES.length;
    }

    const startAt = context.currentTime;
    while (this.resonanceVoices.length >= RESONANCE_VOICE_LIMIT) {
      this.fadeResonanceVoice(this.resonanceVoices.shift(), startAt);
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const peak =
      (note <= 285 ? RESONANCE_PEAK_LOW : RESONANCE_PEAK_HIGH) /
      Math.sqrt(this.resonanceVoices.length + 1);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 1.8);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(startAt);
    oscillator.stop(startAt + 1.85);

    const voice = { oscillator, gain };
    this.resonanceVoices.push(voice);
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      gain.disconnect();
      this.resonanceVoices = this.resonanceVoices.filter((item) => item !== voice);
    });
    return true;
  }

  makeBreathEnvelope(peak, duration) {
    const count = Math.max(48, Math.min(160, Math.round(duration * 24)));
    const values = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const t = i / (count - 1);
      let amount;
      if (t < 0.32) amount = 0.5 - 0.5 * Math.cos(Math.PI * (t / 0.32));
      else if (t < 0.52) amount = 1;
      else amount = 0.5 + 0.5 * Math.cos(Math.PI * ((t - 0.52) / 0.48));
      values[i] = Math.max(0.0001, peak * amount);
    }
    return values;
  }

  startGuidedTone(durationSeconds = 6) {
    const context = this.unlock();
    if (!context || !this.master) return false;
    if (this.guidedTone) this.stopGuidedTone(0.2);

    const frequency = SOLFEGGIO_FREQUENCIES[this.resonanceIndex];
    this.resonanceIndex = (this.resonanceIndex + 1) % SOLFEGGIO_FREQUENCIES.length;
    const duration = Math.max(0.9, Math.min(8, Number(durationSeconds) || 6));
    const startAt = context.currentTime;
    const peak = frequency <= 285 ? GUIDED_PEAK_LOW : GUIDED_PEAK_HIGH;
    const mix = context.createGain();
    const oscillator = context.createOscillator();
    mix.gain.setValueCurveAtTime(this.makeBreathEnvelope(peak, duration), startAt, duration);
    mix.connect(this.master);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, startAt);
    oscillator.connect(mix);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.04);
    const voice = { mix, oscillator };
    this.guidedTone = voice;
    oscillator.addEventListener("ended", () => {
      try {
        oscillator.disconnect();
        mix.disconnect();
      } catch {
        // already disconnected
      }
      if (this.guidedTone === voice) this.guidedTone = null;
    });
    return true;
  }

  stopGuidedTone(release = 0.9) {
    if (!this.guidedTone || !this.context) return;

    const { mix, oscillator } = this.guidedTone;
    const now = this.context.currentTime;
    const fade = Math.max(0.18, release);
    mix.gain.cancelScheduledValues(now);
    mix.gain.setValueAtTime(Math.max(0.0001, mix.gain.value), now);
    mix.gain.exponentialRampToValueAtTime(0.0001, now + fade);
    try {
      oscillator.stop(now + fade + 0.04);
    } catch {
      // already stopped
    }
    this.guidedTone = null;
    window.setTimeout(() => {
      try {
        oscillator.disconnect();
        mix.disconnect();
      } catch {
        // already disconnected
      }
    }, (fade + 0.08) * 1000);
  }

  startBlowChord() {
    const context = this.unlock();
    if (!context || !this.master || this.blowChord) return;

    const startAt = context.currentTime;
    const mix = context.createGain();
    mix.gain.setValueAtTime(0.0001, startAt);
    mix.gain.exponentialRampToValueAtTime(1, startAt + 0.28);
    mix.connect(this.master);

    const voices = BLOW_CHORD_FREQUENCIES.map((frequency) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, startAt);
      gain.gain.value = blowChordGain(frequency);
      oscillator.connect(gain);
      gain.connect(mix);
      oscillator.start(startAt);
      return { oscillator, gain };
    });

    this.blowChord = { mix, voices };
  }

  stopBlowChord() {
    if (!this.blowChord || !this.context) return;

    const { mix, voices } = this.blowChord;
    const now = this.context.currentTime;
    mix.gain.cancelScheduledValues(now);
    mix.gain.setValueAtTime(Math.max(0.0001, mix.gain.value), now);
    mix.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    for (const voice of voices) {
      try {
        voice.oscillator.stop(now + 0.42);
      } catch {
        // already stopped
      }
    }
    this.blowChord = null;

    window.setTimeout(() => {
      mix.disconnect();
      for (const voice of voices) {
        try {
          voice.oscillator.disconnect();
          voice.gain.disconnect();
        } catch {
          // already disconnected
        }
      }
    }, 480);
  }
}
