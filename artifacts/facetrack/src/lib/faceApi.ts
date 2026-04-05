import * as faceapi from "@vladmandic/face-api";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model";

let modelsLoaded = false;
let loading = false;
let loadError: string | null = null;

export type LoadStatus = "idle" | "loading" | "ready" | "error";
let loadStatus: LoadStatus = "idle";
const listeners: Array<(s: LoadStatus) => void> = [];

function notify(s: LoadStatus) {
  loadStatus = s;
  listeners.forEach((fn) => fn(s));
}

export function onLoadStatusChange(fn: (s: LoadStatus) => void): () => void {
  listeners.push(fn);
  fn(loadStatus);
  return () => {
    const i = listeners.indexOf(fn);
    if (i !== -1) listeners.splice(i, 1);
  };
}

export async function loadModels(): Promise<void> {
  if (modelsLoaded) return;
  if (loading) {
    await new Promise<void>((res) => {
      const unsub = onLoadStatusChange((s) => {
        if (s === "ready" || s === "error") { unsub(); res(); }
      });
    });
    return;
  }

  loading = true;
  loadError = null;
  notify("loading");

  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    modelsLoaded = true;
    notify("ready");
  } catch (err) {
    loadError = String(err);
    notify("error");
    throw err;
  } finally {
    loading = false;
  }
}

export async function extractDescriptor(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
): Promise<Float32Array | null> {
  if (!modelsLoaded) await loadModels();

  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 });

  const detection = await faceapi
    .detectSingleFace(source, options)
    .withFaceLandmarks(true)
    .withFaceDescriptor();

  return detection?.descriptor ?? null;
}

export function getLoadStatus(): LoadStatus {
  return loadStatus;
}

export function getLoadError(): string | null {
  return loadError;
}
