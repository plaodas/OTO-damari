const MAX_DIMENSION = 280;

function boxBlur(source, width, height, radius) {
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  const span = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += source[y * width + Math.max(0, Math.min(width - 1, x))];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / span;
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
      output[y * width + x] = sum / span;
      const removeY = Math.max(0, y - radius);
      const addY = Math.min(height - 1, y + radius + 1);
      sum += horizontal[addY * width + x] - horizontal[removeY * width + x];
    }
  }

  return output;
}

function sobel(source, width, height) {
  const mag = new Float32Array(source.length);
  const gxOut = new Float32Array(source.length);
  const gyOut = new Float32Array(source.length);

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
      gxOut[i] = gx;
      gyOut[i] = gy;
      mag[i] = Math.hypot(gx, gy);
    }
  }

  return { mag, gx: gxOut, gy: gyOut };
}

function nonMaxSuppression(mag, gx, gy, width, height) {
  const output = new Float32Array(mag.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const m = mag[i];
      if (m <= 1e-6) continue;
      const ax = Math.abs(gx[i]);
      const ay = Math.abs(gy[i]);
      let a = 0;
      let b = 0;
      if (ax > ay * 2.414) {
        a = mag[i - 1];
        b = mag[i + 1];
      } else if (ay > ax * 2.414) {
        a = mag[i - width];
        b = mag[i + width];
      } else if (gx[i] * gy[i] > 0) {
        a = mag[i - width - 1];
        b = mag[i + width + 1];
      } else {
        a = mag[i - width + 1];
        b = mag[i + width - 1];
      }
      if (m >= a && m >= b) output[i] = m;
    }
  }
  return output;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const copy = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(copy.length - 1, Math.floor((copy.length - 1) * ratio)));
  return copy[index];
}

function hysteresis(nms, width, height, low, high) {
  const keep = new Uint8Array(nms.length);
  const queue = [];
  for (let i = 0; i < nms.length; i += 1) {
    if (nms[i] >= high) {
      keep[i] = 1;
      queue.push(i);
    }
  }

  const widthM = width;
  while (queue.length > 0) {
    const i = queue.pop();
    const x = i % widthM;
    const y = (i / widthM) | 0;
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        if (ox === 0 && oy === 0) continue;
        const sx = x + ox;
        const sy = y + oy;
        if (sx < 1 || sy < 1 || sx >= width - 1 || sy >= height - 1) continue;
        const n = sy * widthM + sx;
        if (keep[n] || nms[n] < low) continue;
        keep[n] = 1;
        queue.push(n);
      }
    }
  }
  return keep;
}

function collectContour(keep, nms, width, height) {
  const points = [];
  let cx = 0;
  let cy = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (!keep[i]) continue;
      points.push({ x, y, strength: nms[i] });
      cx += x;
      cy += y;
    }
  }
  if (points.length === 0) return points;
  cx /= points.length;
  cy /= points.length;
  points.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  return points;
}

function hash01(a, b) {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function borderMean(luminance, width, height) {
  const band = 6;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= band && y >= band && x < width - band && y < height - band) continue;
      sum += luminance[y * width + x];
      count += 1;
    }
  }
  return sum / Math.max(1, count);
}

function interiorMean(luminance, width, height) {
  const band = 6;
  let sum = 0;
  let count = 0;
  for (let y = band; y < height - band; y += 1) {
    for (let x = band; x < width - band; x += 1) {
      sum += luminance[y * width + x];
      count += 1;
    }
  }
  return sum / Math.max(1, count);
}

function buildDensityWeights(luminance, width, height, personMask, near) {
  const invert = !personMask && borderMean(luminance, width, height) < interiorMean(luminance, width, height) - 0.06;
  const weights = new Float32Array(luminance.length);
  const positives = [];
  for (let i = 0; i < luminance.length; i += 1) {
    let luma = luminance[i];
    if (invert) luma = 1 - luma;
    let weight = (1 - luma) ** 1.6;
    if (personMask) weight *= Math.max(0, personMask[i]);
    if (near) weight *= 0.7 + 0.3 * near[i];
    weights[i] = weight;
    if (weight > 1e-5) positives.push(weight);
  }

  if (!personMask && positives.length > 24) {
    const thresh = percentile(positives, 0.55) * 0.85;
    for (let i = 0; i < weights.length; i += 1) {
      weights[i] = Math.max(0, weights[i] - thresh);
    }
  }
  return weights;
}

function packDensityTargets(weights, width, height, targetCount) {
  const pixels = new Uint8Array(targetCount * 4);
  const oversample = 2.2;
  const cols = Math.max(8, Math.round(Math.sqrt((targetCount * oversample * width) / height)));
  const rows = Math.max(8, Math.round((targetCount * oversample) / cols));
  const candidates = [];

  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor((row * height) / rows);
    const y1 = Math.floor(((row + 1) * height) / rows);
    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.floor((col * width) / cols);
      const x1 = Math.floor(((col + 1) * width) / cols);
      let best = 0;
      let bestX = (x0 + x1) * 0.5;
      let bestY = (y0 + y1) * 0.5;
      for (let y = y0; y < Math.max(y0 + 1, y1); y += 1) {
        for (let x = x0; x < Math.max(x0 + 1, x1); x += 1) {
          const value = weights[y * width + x];
          if (value <= best) continue;
          best = value;
          bestX = x + 0.5;
          bestY = y + 0.5;
        }
      }
      if (best <= 1e-5) continue;
      const jx = (hash01(col + 1, row + 3) - 0.5) * Math.max(1, x1 - x0) * 0.35;
      const jy = (hash01(row + 7, col + 11) - 0.5) * Math.max(1, y1 - y0) * 0.35;
      candidates.push({
        x: Math.max(0, Math.min(width - 1, bestX + jx)),
        y: Math.max(0, Math.min(height - 1, bestY + jy)),
        w: best,
      });
    }
  }

  if (candidates.length === 0) return pixels;

  let total = 0;
  for (const candidate of candidates) total += candidate.w;
  const cdf = new Float32Array(candidates.length);
  let acc = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    acc += candidates[i].w / total;
    cdf[i] = acc;
  }
  cdf[candidates.length - 1] = 1;

  const spacing = Math.max(1, Math.min(width, height) / Math.sqrt(targetCount)) * 0.18;
  for (let i = 0; i < targetCount; i += 1) {
    const r = hash01(i + 41, i * 13 + 7);
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const source = candidates[lo];
    const px = source.x + (hash01(i + 19, source.y) - 0.5) * spacing;
    const py = source.y + (hash01(source.x, i + 29) - 0.5) * spacing;
    const offset = i * 4;
    pixels[offset] = Math.round(Math.max(0, Math.min(255, (px / width) * 255)));
    pixels[offset + 1] = Math.round(Math.max(0, Math.min(255, (py / height) * 255)));
    pixels[offset + 2] = 255;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function packTargets(contour, width, height, targetCount) {
  const pixels = new Uint8Array(targetCount * 4);
  if (contour.length === 0) return pixels;

  for (let i = 0; i < targetCount; i += 1) {
    const t = (i + 0.5) / targetCount;
    const at = t * contour.length;
    const index = Math.min(contour.length - 1, at | 0);
    const next = (index + 1) % contour.length;
    const mix = at - index;
    const a = contour[index];
    const b = contour[next];
    const x = a.x + (b.x - a.x) * mix;
    const y = a.y + (b.y - a.y) * mix;
    const tx = b.x - contour[(index + contour.length - 1) % contour.length].x;
    const ty = b.y - contour[(index + contour.length - 1) % contour.length].y;
    const len = Math.hypot(tx, ty) || 1;
    const hashA = Math.sin((i + 1) * 91.345) * 43758.5453;
    const hashB = Math.sin((i + 1) * 47.137) * 15731.743;
    const normalScatter = (hashA - Math.floor(hashA) - 0.5) * 15;
    const tangentScatter = (hashB - Math.floor(hashB) - 0.5) * 8;
    const px = x + (-ty / len) * normalScatter + (tx / len) * tangentScatter;
    const py = y + (tx / len) * normalScatter + (ty / len) * tangentScatter;
    const offset = i * 4;
    pixels[offset] = Math.round(Math.max(0, Math.min(255, (px / width) * 255)));
    pixels[offset + 1] = Math.round(Math.max(0, Math.min(255, (py / height) * 255)));
    pixels[offset + 2] = 255;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function floodBackground(coarse, width, height) {
  const background = new Uint8Array(coarse.length);
  const queue = [];
  let borderSum = 0;
  let borderCount = 0;
  const band = 5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= band && y >= band && x < width - band && y < height - band) continue;
      const i = y * width + x;
      borderSum += coarse[i];
      borderCount += 1;
      background[i] = 1;
      queue.push(i);
    }
  }
  const border = borderSum / Math.max(1, borderCount);
  const similar = 0.09;
  while (queue.length > 0) {
    const i = queue.pop();
    const x = i % width;
    const y = (i / width) | 0;
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        if (ox === 0 && oy === 0) continue;
        const sx = x + ox;
        const sy = y + oy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const n = sy * width + sx;
        if (background[n]) continue;
        if (Math.abs(coarse[n] - coarse[i]) > similar) continue;
        if (Math.abs(coarse[n] - border) > 0.16) continue;
        background[n] = 1;
        queue.push(n);
      }
    }
  }
  return background;
}

function largestForeground(background, width, height) {
  const seen = new Uint8Array(background.length);
  let best = [];
  for (let start = 0; start < background.length; start += 1) {
    if (background[start] || seen[start]) continue;
    const stack = [start];
    const cells = [];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop();
      cells.push(i);
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0 && !background[i - 1] && !seen[i - 1]) {
        seen[i - 1] = 1;
        stack.push(i - 1);
      }
      if (x < width - 1 && !background[i + 1] && !seen[i + 1]) {
        seen[i + 1] = 1;
        stack.push(i + 1);
      }
      if (y > 0 && !background[i - width] && !seen[i - width]) {
        seen[i - width] = 1;
        stack.push(i - width);
      }
      if (y < height - 1 && !background[i + width] && !seen[i + width]) {
        seen[i + width] = 1;
        stack.push(i + width);
      }
    }
    if (cells.length > best.length) best = cells;
  }

  const mask = new Uint8Array(background.length);
  const minSize = width * height * 0.035;
  if (best.length < minSize || best.length > width * height * 0.82) return mask;
  for (const i of best) mask[i] = 1;
  return mask;
}

function traceBoundary(keep, width, height) {
  let start = -1;
  for (let i = 0; i < keep.length; i += 1) {
    if (keep[i]) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];

  const dirs = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const points = [];
  let x = start % width;
  let y = (start / width) | 0;
  const startX = x;
  const startY = y;
  let dir = 0;

  for (let step = 0; step < keep.length; step += 1) {
    points.push({ x, y, strength: 1 });
    let found = false;
    for (let k = 0; k < 8; k += 1) {
      const nextDir = (dir + 6 + k) % 8;
      const nx = x + dirs[nextDir][0];
      const ny = y + dirs[nextDir][1];
      if (nx < 1 || ny < 1 || nx >= width - 1 || ny >= height - 1) continue;
      if (!keep[ny * width + nx]) continue;
      x = nx;
      y = ny;
      dir = nextDir;
      found = true;
      break;
    }
    if (!found) break;
    if (points.length > 16 && x === startX && y === startY) break;
  }
  return points;
}

function silhouette(mask, width, height) {
  const keep = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (!mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width]) {
        keep[i] = 1;
      }
    }
  }
  return traceBoundary(keep, width, height);
}

function extractContour(luminance, width, height) {
  const coarse = boxBlur(boxBlur(luminance, width, height, 5), width, height, 3);
  const background = floodBackground(coarse, width, height);
  const subject = largestForeground(background, width, height);
  const outline = silhouette(subject, width, height);
  if (outline.length >= 60) return outline;

  const { mag, gx, gy } = sobel(coarse, width, height);
  const nms = nonMaxSuppression(mag, gx, gy, width, height);
  const positives = [];
  for (let i = 0; i < nms.length; i += 1) {
    if (nms[i] > 0) positives.push(nms[i]);
  }
  const high = Math.max(0.015, percentile(positives, 0.86));
  const keep = hysteresis(nms, width, height, high * 0.4, high);
  const contour = collectContour(keep, nms, width, height);
  if (contour.length >= 80) return contour;

  const ranked = [];
  for (let i = 0; i < nms.length; i += 1) {
    if (nms[i] > 0) ranked.push({ i, v: nms[i] });
  }
  ranked.sort((a, b) => b.v - a.v);
  const fallback = new Uint8Array(nms.length);
  const take = Math.min(ranked.length, Math.max(160, Math.floor(ranked.length * 0.04)));
  for (let n = 0; n < take; n += 1) fallback[ranked[n].i] = 1;
  return collectContour(fallback, nms, width, height);
}

function captureCoverCanvas(source, viewportWidth, viewportHeight, mirror = false) {
  const aspect = Math.max(0.5, Math.min(2, viewportWidth / Math.max(1, viewportHeight)));
  const width = aspect >= 1 ? MAX_DIMENSION : Math.max(160, Math.round(MAX_DIMENSION * aspect));
  const height = aspect >= 1 ? Math.max(160, Math.round(MAX_DIMENSION / aspect)) : MAX_DIMENSION;
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
  }
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
  context.restore();
  return canvas;
}

function canvasLuminance(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const luminance = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < luminance.length; i += 1) {
    const offset = i * 4;
    luminance[i] =
      (image.data[offset] * 0.2126 +
        image.data[offset + 1] * 0.7152 +
        image.data[offset + 2] * 0.0722) /
      255;
  }
  return luminance;
}

function resizeFloat(source, sourceWidth, sourceHeight, width, height) {
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const fy = ((y + 0.5) * sourceHeight) / height - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = ((x + 0.5) * sourceWidth) / width - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const tx = fx - x0;
      const v00 = source[y0 * sourceWidth + x0];
      const v10 = source[y0 * sourceWidth + x1];
      const v01 = source[y1 * sourceWidth + x0];
      const v11 = source[y1 * sourceWidth + x1];
      output[y * width + x] =
        v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
    }
  }
  return output;
}

function normalizeDepth(values) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = Math.max(1e-5, max - min);
  const output = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    output[i] = (values[i] - min) / span;
  }
  return output;
}

function fieldFromWeights(weights, width, height, targetCount, luminance) {
  const pixels = packDensityTargets(weights, width, height, targetCount);
  const hasTarget = pixels[3] > 0;
  if (hasTarget) {
    return { width: targetCount, height: 1, pixels };
  }
  const contour = extractContour(luminance, width, height);
  return {
    width: targetCount,
    height: 1,
    pixels: packTargets(contour, width, height, targetCount),
  };
}

export function estimateDepthEdges(
  source,
  viewportWidth,
  viewportHeight,
  targetCount,
  mirror = false,
) {
  const canvas = captureCoverCanvas(source, viewportWidth, viewportHeight, mirror);
  const luminance = canvasLuminance(canvas);
  const weights = buildDensityWeights(luminance, canvas.width, canvas.height, null, null);
  return fieldFromWeights(weights, canvas.width, canvas.height, targetCount, luminance);
}

export async function estimatePhotoField(
  source,
  viewportWidth,
  viewportHeight,
  targetCount,
  mirror = false,
) {
  const canvas = captureCoverCanvas(source, viewportWidth, viewportHeight, mirror);
  const luminance = canvasLuminance(canvas);
  let personFull = null;
  let nearFull = null;

  try {
    const { estimateMidasDepth, segmentPerson } = await import("./photo-ml.js");
    const depth = await estimateMidasDepth(canvas);
    const person = await segmentPerson(canvas);
    if (person) {
      personFull = resizeFloat(person.values, person.width, person.height, canvas.width, canvas.height);
    }
    if (depth) {
      nearFull = normalizeDepth(
        resizeFloat(depth.values, depth.width, depth.height, canvas.width, canvas.height),
      );
    }
  } catch (error) {
    console.warn("奥行き推定に失敗したため、輝度だけで点描します。", error);
  }

  const weights = buildDensityWeights(
    luminance,
    canvas.width,
    canvas.height,
    personFull,
    nearFull,
  );
  return fieldFromWeights(weights, canvas.width, canvas.height, targetCount, luminance);
}
