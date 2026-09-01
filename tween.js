// ========================================================
// tween.js — 缓动函数 + 简易补间引擎
// ========================================================

export const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export class TweenManager {
    constructor() { this._map = new Map(); }
    start(key, from, to, duration, easing = easeInOutCubic) {
        this._map.set(key, { from: from.clone(), to: to.clone(), start: performance.now(), duration, easing, value: from.clone() });
    }
    get(key) { const t = this._map.get(key); return t ? t.value : null; }
    isActive(key) { return this._map.has(key); }
    anyActive() { return this._map.size > 0; }
    update(now) {
        for (const [key, t] of this._map) {
            const elapsed = now - t.start;
            if (elapsed >= t.duration) { t.value.copy(t.to); this._map.delete(key); }
            else { const p = t.easing(elapsed / t.duration); t.value.lerpVectors(t.from, t.to, p); }
        }
    }
}
