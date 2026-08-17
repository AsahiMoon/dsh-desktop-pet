/**
 * dsh-desktop-pet — experience-layer config: defaults + schemastery schema.
 * Registered with the DSH settings service by index.mjs; pushed to the pet
 * window as { type: 'config' } signals (hot-reloaded). The standalone exe
 * reads the same shape from %APPDATA%/dsh-desktop-pet/config.json.
 *
 * `schemastery` is NOT a hard load-time dependency: it is required lazily
 * inside buildSchema() (and null'd when absent) so a bare `dsh plugin add`
 * link-install — which pnpm never equips with the bundle's dependencies —
 * still loads DEFAULTS / NAMESPACE / validateConfig and runs the pet. When
 * the package IS resolvable (registry install hoists it, or a full
 * `npm install` in the checkout), the schema path activates and the DSH
 * settings section works. This keeps "install and it just works" intact
 * without forcing a ~heavy schemastery pre-requisite into the link profile.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Try to obtain the schemastery constructor; null when not resolvable. */
let cachedSchema; // undefined = not tried yet
function loadSchemaModule() {
  if (cachedSchema === undefined) {
    try {
      cachedSchema = require("schemastery");
    } catch {
      cachedSchema = null; // not resolvable from this tree
    }
  }
  return cachedSchema;
}

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
  taskBarPersistent: true, // keep the task-progress caption always visible (default on)
  taskBarDetailed: true, // persistent caption shows detailed progress + completed tasks (default on)
  hideWhenIdle: false, // hide the pet window entirely during its long-quiet sleep
  chatWidth: 300, // chat panel width px (user-resizable, remembered)
  chatHeight: 560, // chat panel height px (user-resizable, remembered)
});

/** schemastery schema for settings.register (defaults mirror DEFAULTS).
 *  Returns the schema, or null when schemastery is not resolvable (bare
 *  link-install) — callers must treat null as "no settings section". */
export function buildSchema() {
  const z = loadSchemaModule();
  if (!z) return null;
  return z.object({
    size: z.number().min(64).max(256).default(DEFAULTS.size),
    opacity: z.number().min(0.2).max(1).default(DEFAULTS.opacity),
    character: z
      .string()
      .pattern(/^[a-z0-9-]+$/)
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
    chatWidth: z.number().min(240).max(800).default(DEFAULTS.chatWidth),
    chatHeight: z.number().min(280).max(2000).default(DEFAULTS.chatHeight),
  });
}

/** Cross-field validation (schema cannot express). */
export function validateConfig(value) {
  const w = value?.walk;
  if (w && w.intervalMs < w.durationMs * 2) {
    throw new Error("walk.intervalMs 应至少为 durationMs 的两倍");
  }
}
