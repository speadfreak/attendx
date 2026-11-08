export interface StoredFaceDescriptor {
  studentId: number;
  encoding: string;
}

export interface FaceMatch {
  studentId: number;
  distance: number;
  confidence: number;
}

export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== 128 || b.length !== 128) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

export function descriptorConfidence(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 1.2));
}

export function findClosestFaceMatch(
  descriptor: number[],
  storedDescriptors: StoredFaceDescriptor[],
): FaceMatch | null {
  if (descriptor.length !== 128) return null;
  let best: FaceMatch | null = null;
  for (const row of storedDescriptors) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.encoding);
    } catch {
      continue;
    }
    if (!Array.isArray(decoded) || decoded.length !== 128 || decoded.some((value) => !Number.isFinite(value))) {
      continue;
    }
    const distance = euclideanDistance(descriptor, decoded as number[]);
    if (!best || distance < best.distance) {
      best = { studentId: row.studentId, distance, confidence: descriptorConfidence(distance) };
    }
  }
  return best;
}

export interface RankedFaceMatch extends FaceMatch {
  rank: number;
}

/** Top-N candidate matches for an ambiguous capture (review queue / tie-breaker hints). */
export function findClosestFaceMatchAll(
  descriptor: number[],
  storedDescriptors: StoredFaceDescriptor[],
  limit = 3,
): RankedFaceMatch[] {
  if (descriptor.length !== 128) return [];
  const all: FaceMatch[] = [];
  for (const row of storedDescriptors) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.encoding);
    } catch {
      continue;
    }
    if (!Array.isArray(decoded) || decoded.length !== 128 || decoded.some((value) => !Number.isFinite(value))) {
      continue;
    }
    const distance = euclideanDistance(descriptor, decoded as number[]);
    all.push({ studentId: row.studentId, distance, confidence: descriptorConfidence(distance) });
  }
  all.sort((a, b) => a.distance - b.distance);
  return all.slice(0, limit).map((m, i) => ({ ...m, rank: i + 1 }));
}
