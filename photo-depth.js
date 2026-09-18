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

function createNearestEdgeField(edge, width, height) {
  const count = width * height;
  let nearestX = new Int16Array(count);
  let nearestY = new Int16Array(count);
  nearestX.fill(-1);
  nearestY.fill(-1);

  for (let i = 0; i < count; i += 1) {
    if (edge[i] > 0.28) {
      nearestX[i] = i % width;
      nearestY[i] = Math.floor(i / width);
    }
  }

  let nextX = new Int16Array(count);
  let nextY = new Int16Array(count);
  let jump = 1;
  while (jump < Math.max(width, height)) jump *= 2;

  for (jump = Math.floor(jump / 2); jump >= 1; jump = Math.floor(jump / 2)) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        let bestX = nearestX[index];
        let bestY = nearestY[index];
        let bestDistance =
          bestX >= 0 ? (bestX - x) ** 2 + (bestY - y) ** 2 : Number.POSITIVE_INFINITY;

        for (let oy = -jump; oy <= jump; oy += jump) {
          for (let ox = -jump; ox <= jump; ox += jump) {
            const sx = x + ox;
            const sy = y + oy;
            if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
            const sample = sy * width + sx;
            const candidateX = nearestX[sample];
            const candidateY = nearestY[sample];
            if (candidateX < 0) continue;
            const distance = (candidateX - x) ** 2 + (candidateY - y) ** 2;
            if (distance < bestDistance) {
              bestDistance = distance;
              bestX = candidateX;
              bestY = candidateY;
            }
          }
        }

        nextX[index] = bestX;
        nextY[index] = bestY;
      }
    }
    [nearestX, nextX] = [nextX, nearestX];
    [nearestY, nextY] = [nextY, nearestY];
  }

  const pixels = new Uint8Array(count * 4);
  const reach = Math.max(18, Math.min(width, height) * 0.2);
  for (let i = 0; i < count; i += 1) {
    const x = i % width;
    const y = Math.floor(i / width);
    const targetX = nearestX[i];
    const targetY = nearestY[i];
    const offset = i * 4;
    if (targetX < 0) {
      pixels[offset] = 128;
      pixels[offset + 1] = 128;
      continue;
    }

    const dx = (targetX - x) / width;
    const dy = (targetY - y) / height;
    const distance = Math.hypot(targetX - x, targetY - y);
    const influence = Math.max(0, 1 - distance / reach);
    pixels[offset] = Math.round(Math.max(0, Math.min(255, 128 + dx * 127)));
    pixels[offset + 1] = Math.round(Math.max(0, Math.min(255, 128 + dy * 127)));
    pixels[offset + 2] = Math.round(edge[targetY * width + targetX] * 255);
    pixels[offset + 3] = Math.round(influence * 255);
  }

  return pixels;
}

export function estimateDepthEdges(source, viewportWidth, viewportHeight, mirror = false) {
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
    width,
    height,
    pixels: createNearestEdgeField(edges, width, height),
  };
}
