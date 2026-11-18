// The annotation reader uses the browser's DOMParser. Under Node the tests use jsdom's, which leaves
// listeners behind on its window with every parse and slows to a crawl over thousands of files
// (the app's real browser parser doesn't). So: a fresh jsdom window every 200 parses.
import { JSDOM } from "jsdom";

let win = new JSDOM("").window;
let n = 0;
class FreshDOMParser {
  parseFromString(text: string, type: DOMParserSupportedType) {
    if (++n % 200 === 0) {
      win.close();
      win = new JSDOM("").window;
    }
    return new win.DOMParser().parseFromString(text, type);
  }
}
(globalThis as { DOMParser?: unknown }).DOMParser = FreshDOMParser;
