const MIDAS_SIZE = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let loadPromise = null;
let tf = null;
let midas = null;
let segmenter = null;

export function photoModelStatus() {
  return { depth: Boolean(midas), person: Boolean(segmenter) };
}

export function warmupPhotoModels() {
  if (!loadPromise) loadPromise = loadModels();
  return loadPromise;
}

async function loadModels() {
  const tfMod = await import("@tensorflow/tfjs");
  tf = tfMod;
  await tf.ready();
  try {
    await tf.setBackend("webgl");
    await tf.ready();
  } catch (error) {
    console.warn("TF.js WebGL を使えないため CPU で推論します。", error);
    await tf.setBackend("cpu");
    await tf.ready();
  }

  try {
    midas = await tf.loadGraphModel("/models/midas/model.json");
  } catch (error) {
    console.warn("MiDaS を読み込めませんでした。", error);
    midas = null;
  }

  try {
    const bodySegmentation = await import("@tensorflow-models/body-segmentation");
    segmenter = await bodySegmentation.createSegmenter(
      bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation,
      {
        runtime: "tfjs",
        modelType: "general",
        modelUrl: "/models/selfie/model.json",
      },
    );
  } catch (error) {
    console.warn("人物マスクを読み込めませんでした。奥行きのみで続行します。", error);
    segmenter = null;
  }
}

async function disposeMaskTensors(people) {
  if (!people) return;
  for (const person of people) {
    try {
      const tensor = await person.mask?.toTensor?.();
      tensor?.dispose?.();
    } catch {
      // Mask tensors are best-effort; a failed dispose must not block the next shot.
    }
  }
}

export async function estimateMidasDepth(canvas) {
  await warmupPhotoModels();
  if (!tf || !midas) return null;

  tf.engine().startScope();
  try {
    const input = tf.tidy(() => {
      const pixels = tf.browser.fromPixels(canvas).toFloat().div(255);
      const resized = tf.image.resizeBilinear(pixels, [MIDAS_SIZE, MIDAS_SIZE], true);
      const mean = tf.tensor1d(MEAN);
      const std = tf.tensor1d(STD);
      const normalized = resized.sub(mean).div(std);
      return normalized.transpose([2, 0, 1]).expandDims(0);
    });
    const executed = midas.execute(input, "797");
    const output = Array.isArray(executed) ? executed[0] : executed;
    const squeezed = output.squeeze();
    const values = await squeezed.data();
    return { values: new Float32Array(values), width: MIDAS_SIZE, height: MIDAS_SIZE };
  } catch (error) {
    console.warn("MiDaS の推論に失敗しました。", error);
    return null;
  } finally {
    tf.engine().endScope();
  }
}

export async function segmentPerson(canvas) {
  await warmupPhotoModels();
  if (!segmenter) return null;
  let people = null;
  try {
    people = await segmenter.segmentPeople(canvas, {
      flipHorizontal: false,
      multiSegmentation: false,
      segmentBodyParts: false,
    });
    if (!people?.length) return null;
    const image = await people[0].mask.toImageData();
    const mask = new Float32Array(image.width * image.height);
    let count = 0;
    for (let i = 0; i < mask.length; i += 1) {
      const value = Math.max(image.data[i * 4], image.data[i * 4 + 3]) / 255;
      mask[i] = value;
      if (value > 0.5) count += 1;
    }
    if (count < mask.length * 0.035) return null;
    return { values: mask, width: image.width, height: image.height };
  } catch (error) {
    console.warn("人物マスクの推論に失敗しました。", error);
    return null;
  } finally {
    await disposeMaskTensors(people);
  }
}
