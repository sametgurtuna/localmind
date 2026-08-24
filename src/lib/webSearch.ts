import type { SearchResult } from "../hooks/useSearch";

export interface WebSearchEngine {
  prefix: string;
  name: string;
  badge: string;
  icon: string;
  searchUrl: (q: string) => string;
}

export const WEB_ENGINES: Record<string, WebSearchEngine> = {
  google: {
    prefix: "!g",
    name: "Google",
    badge: "GOOGLE",
    icon: "google",
    searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  youtube: {
    prefix: "!yt",
    name: "YouTube",
    badge: "YOUTUBE",
    icon: "youtube",
    searchUrl: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  },
  github: {
    prefix: "!gh",
    name: "GitHub",
    badge: "GITHUB",
    icon: "github",
    searchUrl: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
  },
  wiki: {
    prefix: "!w",
    name: "Wikipedia",
    badge: "WIKIPEDIA",
    icon: "wikipedia",
    searchUrl: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  },
  reddit: {
    prefix: "!r",
    name: "Reddit",
    badge: "REDDIT",
    icon: "reddit",
    searchUrl: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  },
  translate: {
    prefix: "!tr",
    name: "Google Translate",
    badge: "TRANSLATE",
    icon: "translate",
    searchUrl: (q) => `https://translate.google.com/?text=${encodeURIComponent(q)}&sl=auto&tl=en`,
  },
  maps: {
    prefix: "!m",
    name: "Google Maps",
    badge: "MAPS",
    icon: "maps",
    searchUrl: (q) => `https://www.google.com/maps/search/${encodeURIComponent(q)}`,
  },
  npm: {
    prefix: "!npm",
    name: "NPM Package",
    badge: "NPM",
    icon: "npm",
    searchUrl: (q) => `https://www.npmjs.com/search?q=${encodeURIComponent(q)}`,
  },
  pypi: {
    prefix: "!pypi",
    name: "PyPI Package",
    badge: "PYPI",
    icon: "pypi",
    searchUrl: (q) => `https://pypi.org/search/?q=${encodeURIComponent(q)}`,
  },
  so: {
    prefix: "!so",
    name: "Stack Overflow",
    badge: "STACKOVERFLOW",
    icon: "stackoverflow",
    searchUrl: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  },
  chatgpt: {
    prefix: "!ai",
    name: "ChatGPT",
    badge: "CHATGPT",
    icon: "chatgpt",
    searchUrl: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  },
  x: {
    prefix: "!x",
    name: "X (Twitter)",
    badge: "X",
    icon: "x",
    searchUrl: (q) => `https://x.com/search?q=${encodeURIComponent(q)}`,
  },
};

// Aliases mapping for prefix shortcuts
const PREFIX_ALIASES: Record<string, string> = {
  "!g": "google",
  "g": "google",
  "google": "google",

  "!yt": "youtube",
  "!y": "youtube",
  "yt": "youtube",
  "youtube": "youtube",

  "!gh": "github",
  "gh": "github",
  "github": "github",

  "!w": "wiki",
  "w": "wiki",
  "wiki": "wiki",
  "wikipedia": "wiki",

  "!r": "reddit",
  "r": "reddit",
  "reddit": "reddit",

  "!t": "translate",
  "!tr": "translate",
  "tr": "translate",
  "translate": "translate",

  "!m": "maps",
  "!map": "maps",
  "map": "maps",
  "maps": "maps",

  "!npm": "npm",
  "npm": "npm",

  "!pypi": "pypi",
  "pypi": "pypi",

  "!so": "so",
  "so": "so",
  "stack": "so",
  "stackoverflow": "so",

  "!ai": "chatgpt",
  "!gpt": "chatgpt",
  "gpt": "chatgpt",
  "chatgpt": "chatgpt",

  "!x": "x",
  "x": "x",
  "twitter": "x",
};

/**
 * Checks if the user typed a direct URL like "github.com", "https://...", "google.com/maps", "localhost:3000"
 */
export function parseDirectUrl(raw: string): SearchResult | null {
  const q = raw.trim();
  if (q.length < 3) return null;

  const isHttp = q.startsWith("http://") || q.startsWith("https://");
  const domainMatch = q.match(/^[a-zA-Z0-9-]+\.(?:com|org|net|io|dev|app|ai|me|co|edu|gov|tr|de|uk)(?:\/[^\s]*)?$/i);
  const localhostMatch = q.match(/^localhost(?::[0-9]+)?(?:\/[^\s]*)?$/i);

  if (isHttp || domainMatch || localhostMatch) {
    const url = isHttp ? q : `https://${q}`;
    return {
      fileName: `Open Webpage: ${q}`,
      filePath: url,
      snippet: `${url} • Opens in default browser • Press Enter`,
      score: 1.0,
      category: "web",
      action: "open_url",
      actionTitle: "Open Webpage",
      icon: "globe",
    };
  }

  return null;
}

/**
 * Checks if query starts with a web search shortcut (e.g. "!g react 19", "yt lofi beats", "gh tauri")
 */
export function parseWebShortcutQuery(raw: string): SearchResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. Bang prefix (e.g. "!g query", "!yt music", "!gh repo")
  if (trimmed.startsWith("!")) {
    const spaceIdx = trimmed.indexOf(" ");
    const bang = spaceIdx === -1 ? trimmed : trimmed.substring(0, spaceIdx);
    const searchQuery = spaceIdx === -1 ? "" : trimmed.substring(spaceIdx + 1).trim();

    const engineKey = PREFIX_ALIASES[bang.toLowerCase()];
    if (engineKey && WEB_ENGINES[engineKey]) {
      const engine = WEB_ENGINES[engineKey];
      const targetQuery = searchQuery || "...";
      const targetUrl = engine.searchUrl(searchQuery);

      return {
        fileName: `Search on ${engine.name}: "${targetQuery}"`,
        filePath: targetUrl,
        snippet: `Search "${targetQuery}" on ${engine.name} • Press Enter to open in browser`,
        score: 1.0,
        category: "web",
        action: "open_url",
        actionTitle: `Search on ${engine.name}`,
        icon: engine.icon,
      };
    }
  }

  // 2. Keyword prefix (e.g. "google react", "yt synthwave", "gh localmind")
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const firstWord = parts[0].toLowerCase();
    const searchQuery = parts.slice(1).join(" ");
    const engineKey = PREFIX_ALIASES[firstWord];

    if (engineKey && WEB_ENGINES[engineKey] && searchQuery.length > 0) {
      const engine = WEB_ENGINES[engineKey];
      const targetUrl = engine.searchUrl(searchQuery);

      return {
        fileName: `Search on ${engine.name}: "${searchQuery}"`,
        filePath: targetUrl,
        snippet: `Search "${searchQuery}" on ${engine.name} • Press Enter to open in browser`,
        score: 1.0,
        category: "web",
        action: "open_url",
        actionTitle: `Search on ${engine.name}`,
        icon: engine.icon,
      };
    }
  }

  return null;
}

/**
 * Returns a list of quick web search fallback cards to show at the bottom or when 0 results.
 */
export function getWebSearchFallbacks(query: string): SearchResult[] {
  const q = query.trim();
  if (!q || q.length < 2) return [];

  // Filter out any commands/special prefixes
  if (q.startsWith(">") || q.startsWith(":") || q.startsWith("!")) return [];

  return [
    {
      fileName: `Search on Google: "${q}"`,
      filePath: WEB_ENGINES.google.searchUrl(q),
      snippet: `Google Web Search • Press Enter to open in browser`,
      score: 0.2,
      category: "web",
      action: "open_url",
      actionTitle: "Search on Google",
      icon: "google",
    },
    {
      fileName: `Search on YouTube: "${q}"`,
      filePath: WEB_ENGINES.youtube.searchUrl(q),
      snippet: `YouTube Video & Audio Search • Press Enter to open in browser`,
      score: 0.19,
      category: "web",
      action: "open_url",
      actionTitle: "Search on YouTube",
      icon: "youtube",
    },
    {
      fileName: `Search on GitHub: "${q}"`,
      filePath: WEB_ENGINES.github.searchUrl(q),
      snippet: `GitHub Code & Repository Search • Press Enter to open in browser`,
      score: 0.18,
      category: "web",
      action: "open_url",
      actionTitle: "Search on GitHub",
      icon: "github",
    },
    {
      fileName: `Search on Wikipedia: "${q}"`,
      filePath: WEB_ENGINES.wiki.searchUrl(q),
      snippet: `Wikipedia Encyclopedia Search • Press Enter to open in browser`,
      score: 0.17,
      category: "web",
      action: "open_url",
      actionTitle: "Search on Wikipedia",
      icon: "wikipedia",
    },
  ];
}
