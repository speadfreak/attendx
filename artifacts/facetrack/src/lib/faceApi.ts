import * as faceapi from "@vladmandic/face-api";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model";

/**
 * Accuracy tuning (raised from inputSize 224 / threshold 0.4): 320 gives the
 * tiny detector substantially better small-face recall at gate distance while
 * staying real-time on phone CPUs; 0.3 keeps distant/profiled faces in play —
 * the server-side matcher still gates identity on descriptor distance.
 */
export const DETECTOR_INPUT_SIZE = 320;
export const DETECTOR_SCORE_THRESHOLD = 0.3;

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

export interface FaceDetectionDetail {
  descriptor: Float32Array;
  /** Face rect in SOURCE pixel coordinates of the input element. */
  box: { x: number; y: number; width: number; height: number };
  /** Detector confidence 0..1. */
  score: number;
}

export function detectorOptions(): faceapi.TinyFaceDetectorOptions {
  return new faceapi.TinyFaceDetectorOptions({
    inputSize: DETECTOR_INPUT_SIZE,
    scoreThreshold: DETECTOR_SCORE_THRESHOLD,
  });
}

/**
 * Detect ALL faces with boxes + descriptors — feeds both the server matcher
 * (best/largest descriptor) and the HUD overlay (real boxes per face).
 */
export async function detectFacesDetailed(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): Promise<FaceDetectionDetail[]> {
  if (!modelsLoaded) await loadModels();

  const detections = await faceapi
    .detectAllFaces(source, detectorOptions())
    .withFaceLandmarks(true)
    .withFaceDescriptors();

  return detections.map((d) => ({
    descriptor: d.descriptor,
    box: {
      x: d.detection.box.x,
      y: d.detection.box.y,
      width: d.detection.box.width,
      height: d.detection.box.height,
    },
    score: d.detection.score,
  }));
}

/** Largest face in frame (closest to the camera) — the canonical match input. */
export function pickPrimaryFace(faces: FaceDetectionDetail[]): FaceDetectionDetail | null {
  if (faces.length === 0) return null;
  return faces.reduce((best, f) => (f.box.width * f.box.height > best.box.width * best.box.height ? f : best), faces[0]);
}

export async function extractDescriptor(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
): Promise<Float32Array | null> {
  const faces = await detectFacesDetailed(source);
  return faces.length > 0 ? faces[0].descriptor : null;
}

export function getLoadStatus(): LoadStatus {
  return loadStatus;
}

export function getLoadError(): string | null {
  return loadError;
}
