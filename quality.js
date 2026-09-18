export function detectQuality() {
  const mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 820;
  const isPhone = mobile || smallScreen;
  const dpr = window.devicePixelRatio || 1;
  return {
    isPhone,
    particleCount: isPhone ? 900 : 1400,
    jacobiIterations: isPhone ? 8 : 16,
    simMax: isPhone ? 192 : 256,
    simMin: 128,
    dprCap: isPhone || dpr > 2 ? 1.5 : 2,
    slowStreak: 0,
    reduced: false,
  };
}

export function adaptQuality(quality, frameMs, field, particles) {
  if (frameMs > 38) quality.slowStreak += 1;
  else quality.slowStreak = Math.max(0, quality.slowStreak - 1);

  if (quality.reduced || quality.slowStreak < 18) return false;

  quality.reduced = true;
  quality.jacobiIterations = Math.max(4, Math.floor(quality.jacobiIterations / 2));
  quality.simMax = quality.simMin;
  if (field) {
    field.jacobiIterations = quality.jacobiIterations;
    field.quality = quality;
    field.width = 0;
  }
  if (particles) {
    particles.count = Math.max(quality.isPhone ? 700 : 1000, Math.floor(particles.count * 0.65));
    particles.trailCount = Math.min(360, particles.count);
  }
  return true;
}
