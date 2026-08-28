import type { SearchResult } from "../hooks/useSearch";

// Safe Math Functions
const MATH_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const MATH_FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  sin: (x) => Math.sin((x * Math.PI) / 180),
  cos: (x) => Math.cos((x * Math.PI) / 180),
  tan: (x) => Math.tan((x * Math.PI) / 180),
  asin: (x) => (Math.asin(x) * 180) / Math.PI,
  acos: (x) => (Math.acos(x) * 180) / Math.PI,
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  ln: Math.log,
  exp: Math.exp,
};

/**
 * Format calculation numbers cleanly (avoiding floating point quirks like 0.30000000000000004)
 */
function formatCalcResult(val: number): string {
  if (Number.isInteger(val)) {
    return val.toString();
  }
  const fixed = Number(val.toPrecision(12));
  return fixed.toString();
}

/**
 * Evaluates basic & complex mathematical expressions in JavaScript safely.
 */
export function parseMathQuery(rawQuery: string): SearchResult | null {
  let q = rawQuery.trim();
  if (!q) return null;

  // Strip common calculator prefixes
  const qLower = q.toLowerCase();
  if (qLower.startsWith("calc ")) {
    q = q.slice(5).trim();
  } else if (qLower.startsWith("calculator ")) {
    q = q.slice(11).trim();
  } else if (qLower.startsWith("hesap ")) {
    q = q.slice(6).trim();
  } else if (q.startsWith("=")) {
    q = q.slice(1).trim();
  }

  if (q.endsWith("=")) {
    q = q.slice(0, -1).trim();
  }

  if (!q) return null;

  // 1. Percentage pattern: "20% of 500" or "15% * 80"
  const pctOfMatch = q.match(/^(\d+(?:[\.,]\d+)?)\s*%\s*(?:of|\*)\s*(\d+(?:[\.,]\d+)?)$/i);
  if (pctOfMatch) {
    const pct = parseFloat(pctOfMatch[1].replace(",", "."));
    const total = parseFloat(pctOfMatch[2].replace(",", "."));
    const res = (pct / 100) * total;
    const resStr = formatCalcResult(res);
    return {
      fileName: `= ${resStr}`,
      filePath: resStr,
      snippet: `Calculation: ${rawQuery.trim()} = ${resStr}`,
      score: 1.0,
      category: "calc",
      action: "copy",
      actionTitle: "Copy Result",
      icon: "calc",
    };
  }

  // Percentage addition/subtraction: "500 + 20%" or "500 - 10%"
  const pctAddSubMatch = q.match(/^(\d+(?:[\.,]\d+)?)\s*([\+\-])\s*(\d+(?:[\.,]\d+)?)\s*%$/);
  if (pctAddSubMatch) {
    const base = parseFloat(pctAddSubMatch[1].replace(",", "."));
    const op = pctAddSubMatch[2];
    const pct = parseFloat(pctAddSubMatch[3].replace(",", "."));
    const delta = (pct / 100) * base;
    const res = op === "+" ? base + delta : base - delta;
    const resStr = formatCalcResult(res);
    return {
      fileName: `= ${resStr}`,
      filePath: resStr,
      snippet: `Calculation: ${rawQuery.trim()} = ${resStr}`,
      score: 1.0,
      category: "calc",
      action: "copy",
      actionTitle: "Copy Result",
      icon: "calc",
    };
  }

  // 2. Hex / Binary conversions
  const hexMatch = q.match(/^0x([0-9a-fA-F]+)$/);
  if (hexMatch) {
    const val = parseInt(hexMatch[1], 16);
    if (!isNaN(val)) {
      return {
        fileName: `= ${val}`,
        filePath: val.toString(),
        snippet: `Hex to Decimal: ${rawQuery.trim()} = ${val}`,
        score: 1.0,
        category: "calc",
        action: "copy",
        actionTitle: "Copy Decimal Value",
        icon: "calc",
      };
    }
  }

  const binMatch = q.match(/^0b([01]+)$/);
  if (binMatch) {
    const val = parseInt(binMatch[1], 2);
    if (!isNaN(val)) {
      return {
        fileName: `= ${val}`,
        filePath: val.toString(),
        snippet: `Binary to Decimal: ${rawQuery.trim()} = ${val}`,
        score: 1.0,
        category: "calc",
        action: "copy",
        actionTitle: "Copy Decimal Value",
        icon: "calc",
      };
    }
  }

  const toHexMatch = q.match(/^hex\s+(\d+)$/i);
  if (toHexMatch) {
    const val = parseInt(toHexMatch[1], 10);
    if (!isNaN(val)) {
      const hexStr = `0x${val.toString(16).toUpperCase()}`;
      return {
        fileName: `= ${hexStr}`,
        filePath: hexStr,
        snippet: `Decimal to Hex: ${val} = ${hexStr}`,
        score: 1.0,
        category: "calc",
        action: "copy",
        actionTitle: "Copy Hex Value",
        icon: "calc",
      };
    }
  }

  const toBinMatch = q.match(/^bin(?:ary)?\s+(\d+)$/i);
  if (toBinMatch) {
    const val = parseInt(toBinMatch[1], 10);
    if (!isNaN(val)) {
      const binStr = `0b${val.toString(2)}`;
      return {
        fileName: `= ${binStr}`,
        filePath: binStr,
        snippet: `Decimal to Binary: ${val} = ${binStr}`,
        score: 1.0,
        category: "calc",
        action: "copy",
        actionTitle: "Copy Binary Value",
        icon: "calc",
      };
    }
  }

  // 3. Normal Math Expressions
  // Normalize comma decimals (e.g. 3,5 * 2 -> 3.5 * 2)
  let expr = q.replace(/(\d),(\d)/g, "$1.$2");
  // Normalize multiplication 'x' or 'X' surrounded by digits/parens
  expr = expr.replace(/(\d)\s*[xX]\s*(\d)/g, "$1 * $2");
  expr = expr.replace(/\^/g, "**");

  // Validate allowed characters
  if (!/^[0-9\.\+\-\*\/\%\^\(\)\,\s_a-zA-Z]+$/.test(expr)) {
    return null;
  }

  // Must contain at least one digit or math function/constant
  if (!/[0-9]/.test(expr) && !Object.keys(MATH_CONSTANTS).some((k) => expr.toLowerCase().includes(k))) {
    return null;
  }

  // Check if it has operators or function calls
  const hasOperator = /[\+\-\*\/\%\*\*]/.test(expr);
  const hasFunction = Object.keys(MATH_FUNCTIONS).some((fn) => expr.toLowerCase().includes(fn));
  if (!hasOperator && !hasFunction) {
    return null;
  }

  // Prevent JavaScript injection
  const forbidden = ["window", "document", "global", "process", "require", "import", "eval", "Function", "constructor", "prototype", "this", "alert"];
  if (forbidden.some((bad) => expr.toLowerCase().includes(bad))) {
    return null;
  }

  try {
    // Replace functions and constants with Math references
    let safeExpr = expr;
    for (const [name] of Object.entries(MATH_CONSTANTS)) {
      const reg = new RegExp(`\\b${name}\\b`, "gi");
      safeExpr = safeExpr.replace(reg, `MATH_CONSTANTS.${name}`);
    }
    for (const [name] of Object.entries(MATH_FUNCTIONS)) {
      const reg = new RegExp(`\\b${name}\\s*\\(`, "gi");
      safeExpr = safeExpr.replace(reg, `MATH_FUNCTIONS.${name}(`);
    }

    const evaluator = new Function("MATH_CONSTANTS", "MATH_FUNCTIONS", `"use strict"; return (${safeExpr});`);
    const val = evaluator(MATH_CONSTANTS, MATH_FUNCTIONS);

    if (typeof val === "number" && !isNaN(val) && isFinite(val)) {
      const resStr = formatCalcResult(val);
      return {
        fileName: `= ${resStr}`,
        filePath: resStr,
        snippet: `Calculation: ${rawQuery.trim()} = ${resStr}`,
        score: 1.0,
        category: "calc",
        action: "copy",
        actionTitle: "Copy Result",
        icon: "calc",
      };
    }
  } catch {
    return null;
  }

  return null;
}

interface ActionDef {
  keys: string[];
  title: string;
  cmd: string;
  desc: string;
  category: "action" | "app";
  action: "system_command" | "copy" | "open";
  actionTitle: string;
  icon: string;
}

const SYSTEM_ACTION_SPECS: ActionDef[] = [
  {
    keys: ["lock", "lock screen", "lock workstation", "lock pc", "kilit", "kilitle", "ekranı kilitle", "ekrani kilitle", "ekran kilidi"],
    title: "Lock Workstation",
    cmd: "lock",
    desc: "Lock current Windows session (Win + L)",
    category: "action",
    action: "system_command",
    actionTitle: "Lock Screen",
    icon: "lock",
  },
  {
    keys: ["sleep", "sleep pc", "suspend", "uyku", "uyut", "uyku modu", "askıya al", "askiya al"],
    title: "Sleep PC",
    cmd: "sleep",
    desc: "Put computer into sleep mode",
    category: "action",
    action: "system_command",
    actionTitle: "Sleep",
    icon: "sleep",
  },
  {
    keys: ["restart", "reboot", "restart pc", "yeniden başlat", "yeniden baslat", "bilgisayarı yeniden başlat", "bilgisayari yeniden baslat", "reset"],
    title: "Restart Computer",
    cmd: "restart",
    desc: "Reboot Windows operating system",
    category: "action",
    action: "system_command",
    actionTitle: "Restart",
    icon: "restart",
  },
  {
    keys: ["shutdown", "shut down", "power off", "turn off", "kapat", "bilgisayarı kapat", "bilgisayari kapat", "bilgisayar kapat"],
    title: "Shut Down Computer",
    cmd: "shutdown",
    desc: "Turn off Windows computer",
    category: "action",
    action: "system_command",
    actionTitle: "Shut Down",
    icon: "shutdown",
  },
  {
    keys: [
      "empty trash", "empty recycle bin", "recycle bin", "trash",
      "çöpü boşalt", "copu bosalt", "çöp kutusu", "cop kutusu",
      "çöp kutusunu boşalt", "cop kutusunu bosalt", "geri dönüşüm kutusu", "geri donusum kutusu",
    ],
    title: "Empty Recycle Bin",
    cmd: "empty_trash",
    desc: "Permanently delete items in Recycle Bin",
    category: "action",
    action: "system_command",
    actionTitle: "Empty Recycle Bin",
    icon: "trash",
  },
  {
    keys: ["logout", "log out", "sign out", "signout", "oturum kapat", "oturumu kapat"],
    title: "Sign Out",
    cmd: "logout",
    desc: "Sign out of current user session",
    category: "action",
    action: "system_command",
    actionTitle: "Sign Out",
    icon: "logout",
  },
  {
    keys: ["calc", "calculator", "hesap makinesi", "hesap makinasi", "hesap", "hesap makinası"],
    title: "Calculator",
    cmd: "calc",
    desc: "Open Windows Calculator",
    category: "app",
    action: "open",
    actionTitle: "Open Calculator",
    icon: "calc",
  },
];

/**
 * Match system actions against user query
 */
export function parseSystemAction(rawQuery: string): SearchResult[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [];

  const matches: SearchResult[] = [];

  for (const spec of SYSTEM_ACTION_SPECS) {
    const isExact = spec.keys.some((k) => k === q);
    const isPrefix = !isExact && spec.keys.some((k) => k.startsWith(q) || (q.length >= 3 && k.includes(q)));

    if (isExact || isPrefix) {
      matches.push({
        fileName: spec.title,
        filePath: spec.cmd,
        snippet: spec.desc,
        score: isExact ? 1.0 : 0.95,
        category: spec.category,
        action: spec.action,
        actionTitle: spec.actionTitle,
        icon: spec.icon,
      });
    }
  }

  return matches;
}
