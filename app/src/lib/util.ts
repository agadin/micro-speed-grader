/** Small helpers shared across the app. */

/** a short unique id for groups, packs, … */
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
