/**
 * dsh-desktop-pet — experience-layer config: defaults + schemastery schema.
 * Registered with the DSH settings service by index.mjs; pushed to the pet
 * window as { type: 'config' } signals (hot-reloaded). The standalone exe
 * reads the same shape from %APPDATA%/dsh-desktop-pet/config.json.
 */
import z from "schemastery";

export const NAMESPACE = "dsh-desktop-pet";

/** Single source of truth for defaults. */
export const DEFAULTS = Object.freeze({
  size: 110, // pet window side px (64-256)
  opacity: 1, // window opacity 0.2-1
  character: "whale-girl", // character id under assets/characters/
  walk: {
    enabled: true,
    intervalMs: 300000, // 5 min between walks
    durationMs: 26000, // one walk length
  },
  sleepAfterMs: 60000, // idle -> sleep threshold
  bottomMode: false, // pin the pet below other windows (desktop wallpaper style)
  taskBarPersistent: false, // keep the task-progress caption always visible
  taskBarDetailed: false, // persistent caption shows detailed progress + completed tasks
  hideWhenIdle: false, // hide the pet window entirely during its long-quiet sleep
});

/** schemastery schema for settings.register (defaults mirror DEFAULTS). */
export function buildSchema() {
  return z.object({
    size: z.number().min(64).max(256).default(DEFAULTS.size),
    opacity: z.number().min(0.2).max(1).default(DEFAULTS.opacity),
    character: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default(DEFAULTS.character),
    walk: z
      .object({
        enabled: z.boolean().default(DEFAULTS.walk.enabled),
        intervalMs: z.number().min(60000).max(3600000).default(DEFAULTS.walk.intervalMs),
        durationMs: z.number().min(5000).max(120000).default(DEFAULTS.walk.durationMs),
      })
      .default(DEFAULTS.walk),
    sleepAfterMs: z.number().min(5000).max(600000).default(DEFAULTS.sleepAfterMs),
    bottomMode: z.boolean().default(DEFAULTS.bottomMode),
    taskBarPersistent: z.boolean().default(DEFAULTS.taskBarPersistent),
    taskBarDetailed: z.boolean().default(DEFAULTS.taskBarDetailed),
    hideWhenIdle: z.boolean().default(DEFAULTS.hideWhenIdle),
  });
}

/** Cross-field validation (schema cannot express). */
export function validateConfig(value) {
  const w = value?.walk;
  if (w && w.intervalMs < w.durationMs * 2) {
    throw new Error("walk.intervalMs 应至少为 durationMs 的两倍");
  }
}
