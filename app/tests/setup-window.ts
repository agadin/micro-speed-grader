// Imported first by logic.test.ts: src/lib/backend.ts reads `window` when it loads (via lib/loader).
import { JSDOM } from "jsdom";

const g = globalThis as { window?: unknown };
g.window ??= new JSDOM().window;
