const MAX_DIMENSION = 256;

function boxBlur(source, width, height, radius) {
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += source[y * width + Math.max(0, Math.min(width - 1, x))];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / (radius * 2 + 1);
      const removeX = Math.max(0, x - radius);
      const addX = Math.min(width - 1, x + radius + 1);
      sum += source[y * width + addX] - source[y * width + removeX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.max(0, Math.min(height - 1, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / (radius * 2 + 1);
      const removeY = Math.max(0, y - radius);
      const addY = Math.min(height - 1, y + radius + 1);
      sum += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }

  return output;
}

function sobel(source, width, height) {
  const output = new Float32Array(source.length);
  let max = 1e-5;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx =
        -source[i - width - 1] +
        source[i - width + 1] -
        source[i - 1] * 2 +
        source[i + 1] * 2 -
        source[i + width - 1] +
        source[i + width + 1];
      const gy =
        -source[i - width - 1] -
        source[i - width] * 2 -
        source[i - width + 1] +
        source[i + width - 1] +
        source[i + width] * 2 +
        source[i + width + 1];
      const strength = Math.hypot(gx, gy);
      output[i] = strength;
      max = Math.max(max, strength);
    }
  }

  const scale = 1 / Math.max(0.24, max * 0.7);
  for (let i = 0; i < output.length; i += 1) {
    output[i] = Math.min(1, output[i] * scale);
  }
  return output;
}

function createParticleTargets(edge, width, height, targetCount) {
  const candidates = [];
  let totalWeight = 0;

  for (let y = 2; y < height - 2; y += 2) {
    for (let x = 2; x < width - 2; x += 2) {
      const index = y * width + x;
      const strength = edge[index];
      if (strength < 0.24) continue;

      let localMax = true;
      for (let oy = -2; oy <= 2 && localMax; oy += 1) {
        for (let ox = -2; ox <= 2; ox += 1) {
          if (edge[(y + oy) * width + x + ox] > strength + 0.035) {
            localMax = false;
            break;
          }
        }
      }
      if (!localMax) continue;

      const nx = x / width - 0.5;
      const ny = y / height - 0.5;
      const centerWeight = Math.max(0.35, 1 - Math.hypot(nx, ny) * 0.75);
      const weight = strength * strength * centerWeight;
      totalWeight += weight;
      candidates.push({ x, y, strength, totalWeight });
    }
  }

  if (candidates.length === 0) {
    candidates.push({ x: width * 0.5, y: height * 0.5, strength: 0.5, totalWeight: 1 });
    totalWeight = 1;
  }

  const pixels = new Uint8Array(targetCount * 4);
  for (let i = 0; i < targetCount; i += 1) {
    const sample = ((i * 0.61803398875 + 0.17) % 1) * totalWeight;
    let low = 0;
    let high = candidates.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[middle].totalWeight < sample) low = middle + 1;
      else high = middle;
    }

    const target = candidates[low];
    const jitter = (i % 5) - 2;
    const offset = i * 4;
    pixels[offset] = Math.round(
      Math.max(0, Math.min(255, ((target.x + jitter * 0.32) / width) * 255)),
    );
    pixels[offset + 1] = Math.round(
      Math.max(0, Math.min(255, ((target.y + jitter * 0.18) / height) * 255)),
    );
    pixels[offset + 2] = Math.round(target.strength * 255);
    pixels[offset + 3] = 255;
  }

  return pixels;
}

export function estimateDepthEdges(
  source,
  viewportWidth,
  viewportHeight,
  targetCount,
  mirror = false,
) {
  const aspect = Math.max(0.5, Math.min(2, viewportWidth / viewportHeight));
  const width = aspect >= 1 ? MAX_DIMENSION : Math.max(128, Math.round(MAX_DIMENSION * aspect));
  const height = aspect >= 1 ? Math.max(128, Math.round(MAX_DIMENSION / aspect)) : MAX_DIMENSION;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });

  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (width - drawWidth) * 0.5;
  const drawY = (height - drawHeight) * 0.5;

  context.save();
  if (mirror) {
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
  } else {
    context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
  }
  context.restore();

  const image = context.getImageData(0, 0, width, height);
  const luminance = new Float32Array(width * height);
  for (let i = 0; i < luminance.length; i += 1) {
    const offset = i * 4;
    luminance[i] =
      (image.data[offset] * 0.2126 +
        image.data[offset + 1] * 0.7152 +
        image.data[offset + 2] * 0.0722) /
      255;
  }

  const local = boxBlur(luminance, width, height, 2);
  const broad = boxBlur(luminance, width, height, 10);
  const relativeDepth = new Float32Array(luminance.length);
  for (let i = 0; i < relativeDepth.length; i += 1) {
    const x = (i % width) / width - 0.5;
    const y = Math.floor(i / width) / height - 0.5;
    const centerPrior = Math.max(0, 1 - Math.hypot(x, y) * 1.4);
    relativeDepth[i] = Math.max(
      0,
      Math.min(1, 0.54 * broad[i] + 0.3 * local[i] + 0.16 * centerPrior),
    );
  }

  const colorEdges = sobel(local, width, height);
  const depthEdges = sobel(relativeDepth, width, height);
  const edges = new Float32Array(luminance.length);
  for (let i = 0; i < edges.length; i += 1) {
    edges[i] = Math.min(1, colorEdges[i] * 0.62 + depthEdges[i] * 0.78);
  }

  return {
    width: targetCount,
    height: 1,
    pixels: createParticleTargets(edges, width, height, targetCount),
  };
}
