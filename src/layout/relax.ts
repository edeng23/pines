/**
 * Overlap removal: repulsion-only local relaxation.
 *
 * Movable points are pushed apart until no pair sits closer than `minDist`;
 * pinned points never move (existing trees stay put when new ones arrive).
 */

export interface RelaxPoint {
  x: number;
  y: number;
  pinned: boolean;
}

export function relax(points: RelaxPoint[], minDist = 2.4, iterations = 30): void {
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (p.pinned) continue;
      let pushX = 0;
      let pushY = 0;
      for (let j = 0; j < points.length; j++) {
        if (i === j) continue;
        const q = points[j]!;
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        if (dist < 1e-9) {
          // Coincident: push a half-separation in a deterministic direction.
          // (dx/dy are unit-length here — do NOT divide by the zero distance.)
          const angle = (i * 2.399963) % (Math.PI * 2);
          pushX += Math.cos(angle) * minDist * 0.5;
          pushY += Math.sin(angle) * minDist * 0.5;
          continue;
        }
        const overlap = (minDist - dist) / dist;
        pushX += dx * overlap * 0.5;
        pushY += dy * overlap * 0.5;
      }
      if (pushX !== 0 || pushY !== 0) {
        p.x += pushX;
        p.y += pushY;
        moved = true;
      }
    }
    if (!moved) break;
  }
}
