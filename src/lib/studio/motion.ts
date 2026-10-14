// Small animation helpers built around the classic principles: anticipation,
// squash and stretch, arcs, overshoot and follow-through. Everything is a pure
// function of normalised time so a scene can be scrubbed as well as played.

export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Map `t` from [a, b] onto [0, 1], clamped. */
export const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a));

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number) => 1 - (1 - t) ** 3;
export const easeIn = (t: number) => t * t * t;

/** Ease out past the target by `amount`, then settle back. */
export function overshoot(t: number, amount = 0.07) {
  const s = amount * 23;
  const u = t - 1;
  return 1 + (s + 1) * u ** 3 + s * u ** 2;
}

/** A damped wobble that starts at 1 and dies away: the follow-through. */
export function wobble(t: number, bounces = 3, damping = 0.25) {
  if (t <= 0 || t >= 1) return 0;
  return Math.cos(t * bounces * Math.PI * 2) * damping ** (t * bounces);
}

/** Height along a parabolic arc that peaks at `height` halfway through. */
export const arc = (t: number, height: number) => 4 * height * t * (1 - t);

export interface Squash {
  /** Vertical scale. */
  y: number;
  /** Horizontal scale, chosen to keep the volume roughly constant. */
  xz: number;
}

/** Volume-preserving squash (y below 1) or stretch (y above 1). */
export function squash(y: number): Squash {
  return { y, xz: 1 / Math.sqrt(y) };
}

/**
 * The shape of a hop over normalised time:
 * crouch (anticipation), stretch into the air, squash on landing, then wobble.
 * Returns the vertical scale and how far along the path the body is.
 */
export function hop(t: number, { crouch = 0.18, land = 0.78, depth = 0.22 } = {}) {
  let y = 1;
  if (t < crouch) {
    y = 1 - depth * Math.sin(span(t, 0, crouch) * Math.PI * 0.5);
  } else if (t < land) {
    const u = span(t, crouch, land);
    // Snap up out of the crouch into a stretch, relax at the top, stretch again on the way down.
    y = 1 + 0.2 * Math.sin(u * Math.PI) * (1 - 0.6 * Math.sin(u * Math.PI));
    if (u < 0.12) y = lerp(1 - depth, y, u / 0.12);
  } else {
    const u = span(t, land, 1);
    // Ramp into the squash over the first few frames so the landing has no pop.
    y = 1 - depth * 0.9 * wobble(u, 2.5, 0.3) * Math.min(1, u / 0.08);
  }
  const travel = easeInOut(span(t, crouch, land));
  const lift = arc(span(t, crouch, land), 1);
  return { scale: squash(y), travel, lift };
}
