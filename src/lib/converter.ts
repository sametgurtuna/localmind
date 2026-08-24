import type { SearchResult } from "../hooks/useSearch";

// -----------------------------------------------------------------------------
// Baseline Offline Exchange Rates (Base: 1 USD)
// -----------------------------------------------------------------------------
interface ExchangeRates {
  [currency: string]: number;
}

const DEFAULT_RATES: ExchangeRates = {
  USD: 1.0,
  EUR: 0.92,
  TRY: 38.35,
  GBP: 0.79,
  JPY: 153.5,
  CHF: 0.89,
  CAD: 1.41,
  AUD: 1.58,
  CNY: 7.28,
  RUB: 98.5,
  AZN: 1.70,
  AED: 3.67,
  SAR: 3.75,
  INR: 86.8,
  KRW: 1445.0,
  BRL: 5.75,
  // Crypto (Rate in USD: 1 Crypto = X USD -> Store as units per USD)
  BTC: 1 / 95000,
  ETH: 1 / 2700,
  SOL: 1 / 180,
  USDT: 1.0,
  BNB: 1 / 650,
  XRP: 1 / 2.20,
  DOGE: 1 / 0.25,
  AVAX: 1 / 28.0,
  TON: 1 / 4.80,
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  TRY: "₺",
  GBP: "£",
  JPY: "¥",
  RUB: "₽",
  INR: "₹",
  KRW: "₩",
  BTC: "₿",
  ETH: "Ξ",
  SOL: "SOL",
  USDT: "USDT",
};

const CURRENCY_ALIASES: Record<string, string> = {
  // USD
  usd: "USD",
  dolar: "USD",
  dollar: "USD",
  dollars: "USD",
  "$": "USD",
  // EUR
  eur: "EUR",
  euro: "EUR",
  avro: "EUR",
  "€": "EUR",
  // TRY
  try: "TRY",
  tl: "TRY",
  "₺": "TRY",
  lira: "TRY",
  turklirasi: "TRY",
  türklirası: "TRY",
  turkishlira: "TRY",
  // GBP
  gbp: "GBP",
  sterlin: "GBP",
  pound: "GBP",
  pounds: "GBP",
  "£": "GBP",
  // JPY
  jpy: "JPY",
  yen: "JPY",
  "¥": "JPY",
  // CHF
  chf: "CHF",
  frank: "CHF",
  franc: "CHF",
  // CAD
  cad: "CAD",
  candolar: "CAD",
  // AUD
  aud: "AUD",
  // CNY
  cny: "CNY",
  yuan: "CNY",
  rmb: "CNY",
  // RUB
  rub: "RUB",
  ruble: "RUB",
  // AZN
  azn: "AZN",
  manat: "AZN",
  // AED
  aed: "AED",
  dirham: "AED",
  // SAR
  sar: "SAR",
  riyal: "SAR",
  // INR
  inr: "INR",
  rupi: "INR",
  rupee: "INR",
  // Crypto
  btc: "BTC",
  bitcoin: "BTC",
  "₿": "BTC",
  eth: "ETH",
  ethereum: "ETH",
  ether: "ETH",
  "Ξ": "ETH",
  sol: "SOL",
  solana: "SOL",
  usdt: "USDT",
  tether: "USDT",
  bnb: "BNB",
  xrp: "XRP",
  ripple: "XRP",
  doge: "DOGE",
  dogecoin: "DOGE",
  avax: "AVAX",
  avalanche: "AVAX",
  ton: "TON",
};

// -----------------------------------------------------------------------------
// Physical & Digital Unit Conversion Tables (Base Unit: standard SI)
// -----------------------------------------------------------------------------
interface UnitDef {
  category: string;
  name: string;
  symbol: string;
  toBase: (val: number) => number;
  fromBase: (val: number) => number;
}

const UNIT_TABLE: Record<string, UnitDef> = {
  // Length (Base: Meter)
  m: { category: "length", name: "Metre", symbol: "m", toBase: (v) => v, fromBase: (v) => v },
  meter: { category: "length", name: "Metre", symbol: "m", toBase: (v) => v, fromBase: (v) => v },
  metre: { category: "length", name: "Metre", symbol: "m", toBase: (v) => v, fromBase: (v) => v },
  km: { category: "length", name: "Kilometre", symbol: "km", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  kilometre: { category: "length", name: "Kilometre", symbol: "km", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  kilometer: { category: "length", name: "Kilometre", symbol: "km", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  cm: { category: "length", name: "Santimetre", symbol: "cm", toBase: (v) => v / 100, fromBase: (v) => v * 100 },
  santimetre: { category: "length", name: "Santimetre", symbol: "cm", toBase: (v) => v / 100, fromBase: (v) => v * 100 },
  centimeter: { category: "length", name: "Santimetre", symbol: "cm", toBase: (v) => v / 100, fromBase: (v) => v * 100 },
  mm: { category: "length", name: "Milimetre", symbol: "mm", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
  milimetre: { category: "length", name: "Milimetre", symbol: "mm", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
  millimeter: { category: "length", name: "Milimetre", symbol: "mm", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
  mi: { category: "length", name: "Mil", symbol: "mi", toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
  mile: { category: "length", name: "Mil", symbol: "mi", toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
  miles: { category: "length", name: "Mil", symbol: "mi", toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
  mil: { category: "length", name: "Mil", symbol: "mi", toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
  yd: { category: "length", name: "Yarda", symbol: "yd", toBase: (v) => v * 0.9144, fromBase: (v) => v / 0.9144 },
  yard: { category: "length", name: "Yarda", symbol: "yd", toBase: (v) => v * 0.9144, fromBase: (v) => v / 0.9144 },
  yarda: { category: "length", name: "Yarda", symbol: "yd", toBase: (v) => v * 0.9144, fromBase: (v) => v / 0.9144 },
  ft: { category: "length", name: "Foot / Feet", symbol: "ft", toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
  foot: { category: "length", name: "Foot / Feet", symbol: "ft", toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
  feet: { category: "length", name: "Foot / Feet", symbol: "ft", toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
  in: { category: "length", name: "İnç", symbol: "in", toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
  inch: { category: "length", name: "İnç", symbol: "in", toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
  inches: { category: "length", name: "İnç", symbol: "in", toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
  inc: { category: "length", name: "İnç", symbol: "in", toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
  inç: { category: "length", name: "İnç", symbol: "in", toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
  nm: { category: "length", name: "Deniz Mili", symbol: "nm", toBase: (v) => v * 1852, fromBase: (v) => v / 1852 },

  // Weight / Mass (Base: Kilogram)
  kg: { category: "weight", name: "Kilogram", symbol: "kg", toBase: (v) => v, fromBase: (v) => v },
  kilo: { category: "weight", name: "Kilogram", symbol: "kg", toBase: (v) => v, fromBase: (v) => v },
  kilogram: { category: "weight", name: "Kilogram", symbol: "kg", toBase: (v) => v, fromBase: (v) => v },
  g: { category: "weight", name: "Gram", symbol: "g", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
  gram: { category: "weight", name: "Gram", symbol: "g", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
  mg: { category: "weight", name: "Miligram", symbol: "mg", toBase: (v) => v / 1000000, fromBase: (v) => v * 1000000 },
  milligram: { category: "weight", name: "Miligram", symbol: "mg", toBase: (v) => v / 1000000, fromBase: (v) => v * 1000000 },
  lb: { category: "weight", name: "Pound (lbs)", symbol: "lbs", toBase: (v) => v * 0.45359237, fromBase: (v) => v / 0.45359237 },
  lbs: { category: "weight", name: "Pound (lbs)", symbol: "lbs", toBase: (v) => v * 0.45359237, fromBase: (v) => v / 0.45359237 },
  pound: { category: "weight", name: "Pound (lbs)", symbol: "lbs", toBase: (v) => v * 0.45359237, fromBase: (v) => v / 0.45359237 },
  pounds: { category: "weight", name: "Pound (lbs)", symbol: "lbs", toBase: (v) => v * 0.45359237, fromBase: (v) => v / 0.45359237 },
  oz: { category: "weight", name: "Ons (Ounce)", symbol: "oz", toBase: (v) => v * 0.0283495231, fromBase: (v) => v / 0.0283495231 },
  ons: { category: "weight", name: "Ons (Ounce)", symbol: "oz", toBase: (v) => v * 0.0283495231, fromBase: (v) => v / 0.0283495231 },
  ounce: { category: "weight", name: "Ons (Ounce)", symbol: "oz", toBase: (v) => v * 0.0283495231, fromBase: (v) => v / 0.0283495231 },
  ounces: { category: "weight", name: "Ons (Ounce)", symbol: "oz", toBase: (v) => v * 0.0283495231, fromBase: (v) => v / 0.0283495231 },
  ton: { category: "weight", name: "Ton", symbol: "ton", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  tonnes: { category: "weight", name: "Ton", symbol: "ton", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },

  // Temperature (Base: Celsius)
  c: { category: "temp", name: "Celsius", symbol: "°C", toBase: (v) => v, fromBase: (v) => v },
  celsius: { category: "temp", name: "Celsius", symbol: "°C", toBase: (v) => v, fromBase: (v) => v },
  santigrat: { category: "temp", name: "Santigrat", symbol: "°C", toBase: (v) => v, fromBase: (v) => v },
  f: { category: "temp", name: "Fahrenheit", symbol: "°F", toBase: (v) => (v - 32) * (5 / 9), fromBase: (v) => (v * 9) / 5 + 32 },
  fahrenheit: { category: "temp", name: "Fahrenheit", symbol: "°F", toBase: (v) => (v - 32) * (5 / 9), fromBase: (v) => (v * 9) / 5 + 32 },
  k: { category: "temp", name: "Kelvin", symbol: "K", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
  kelvin: { category: "temp", name: "Kelvin", symbol: "K", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },

  // Digital Storage (Base: Megabyte)
  b: { category: "data", name: "Byte", symbol: "B", toBase: (v) => v / (1024 * 1024), fromBase: (v) => v * 1024 * 1024 },
  byte: { category: "data", name: "Byte", symbol: "B", toBase: (v) => v / (1024 * 1024), fromBase: (v) => v * 1024 * 1024 },
  bytes: { category: "data", name: "Byte", symbol: "B", toBase: (v) => v / (1024 * 1024), fromBase: (v) => v * 1024 * 1024 },
  kb: { category: "data", name: "Kilobyte", symbol: "KB", toBase: (v) => v / 1024, fromBase: (v) => v * 1024 },
  kilobyte: { category: "data", name: "Kilobyte", symbol: "KB", toBase: (v) => v / 1024, fromBase: (v) => v * 1024 },
  mb: { category: "data", name: "Megabyte", symbol: "MB", toBase: (v) => v, fromBase: (v) => v },
  megabyte: { category: "data", name: "Megabyte", symbol: "MB", toBase: (v) => v, fromBase: (v) => v },
  gb: { category: "data", name: "Gigabyte", symbol: "GB", toBase: (v) => v * 1024, fromBase: (v) => v / 1024 },
  gigabyte: { category: "data", name: "Gigabyte", symbol: "GB", toBase: (v) => v * 1024, fromBase: (v) => v / 1024 },
  tb: { category: "data", name: "Terabyte", symbol: "TB", toBase: (v) => v * 1024 * 1024, fromBase: (v) => v / (1024 * 1024) },
  terabyte: { category: "data", name: "Terabyte", symbol: "TB", toBase: (v) => v * 1024 * 1024, fromBase: (v) => v / (1024 * 1024) },
  pb: { category: "data", name: "Petabyte", symbol: "PB", toBase: (v) => v * 1024 * 1024 * 1024, fromBase: (v) => v / (1024 * 1024 * 1024) },

  // Speed (Base: km/h)
  kmh: { category: "speed", name: "km/sa", symbol: "km/h", toBase: (v) => v, fromBase: (v) => v },
  "km/h": { category: "speed", name: "km/sa", symbol: "km/h", toBase: (v) => v, fromBase: (v) => v },
  kph: { category: "speed", name: "km/sa", symbol: "km/h", toBase: (v) => v, fromBase: (v) => v },
  mph: { category: "speed", name: "Mil/Saat", symbol: "mph", toBase: (v) => v * 1.609344, fromBase: (v) => v / 1.609344 },
  mps: { category: "speed", name: "m/sn", symbol: "m/s", toBase: (v) => v * 3.6, fromBase: (v) => v / 3.6 },
  "m/s": { category: "speed", name: "m/sn", symbol: "m/s", toBase: (v) => v * 3.6, fromBase: (v) => v / 3.6 },
  knot: { category: "speed", name: "Knot", symbol: "kn", toBase: (v) => v * 1.852, fromBase: (v) => v / 1.852 },
  knots: { category: "speed", name: "Knot", symbol: "kn", toBase: (v) => v * 1.852, fromBase: (v) => v / 1.852 },
  kn: { category: "speed", name: "Knot", symbol: "kn", toBase: (v) => v * 1.852, fromBase: (v) => v / 1.852 },

  // Volume (Base: Liter)
  l: { category: "volume", name: "Litre", symbol: "L", toBase: (v) => v, fromBase: (v) => v },
  litre: { category: "volume", name: "Litre", symbol: "L", toBase: (v) => v, fromBase: (v) => v },
  liter: { category: "volume", name: "Litre", symbol: "L", toBase: (v) => v, fromBase: (v) => v },
  ml: { category: "volume", name: "Mililitre", symbol: "ml", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
  mililitre: { category: "volume", name: "Mililitre", symbol: "ml", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
  milliliter: { category: "volume", name: "Mililitre", symbol: "ml", toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
  gal: { category: "volume", name: "Galon (US)", symbol: "gal", toBase: (v) => v * 3.78541, fromBase: (v) => v / 3.78541 },
  gallon: { category: "volume", name: "Galon (US)", symbol: "gal", toBase: (v) => v * 3.78541, fromBase: (v) => v / 3.78541 },
  gallons: { category: "volume", name: "Galon (US)", symbol: "gal", toBase: (v) => v * 3.78541, fromBase: (v) => v / 3.78541 },

  // Area (Base: m2)
  m2: { category: "area", name: "Metrekare", symbol: "m²", toBase: (v) => v, fromBase: (v) => v },
  sqm: { category: "area", name: "Metrekare", symbol: "m²", toBase: (v) => v, fromBase: (v) => v },
  sqft: { category: "area", name: "Fitkare", symbol: "sq ft", toBase: (v) => v * 0.092903, fromBase: (v) => v / 0.092903 },
  ft2: { category: "area", name: "Fitkare", symbol: "sq ft", toBase: (v) => v * 0.092903, fromBase: (v) => v / 0.092903 },
  km2: { category: "area", name: "Kilometrekare", symbol: "km²", toBase: (v) => v * 1000000, fromBase: (v) => v / 1000000 },
  sqmi: { category: "area", name: "Milkare", symbol: "sq mi", toBase: (v) => v * 2589988.11, fromBase: (v) => v / 2589988.11 },
  acre: { category: "area", name: "Acre", symbol: "ac", toBase: (v) => v * 4046.86, fromBase: (v) => v / 4046.86 },
  acres: { category: "area", name: "Acre", symbol: "ac", toBase: (v) => v * 4046.86, fromBase: (v) => v / 4046.86 },
  hektar: { category: "area", name: "Hektar", symbol: "ha", toBase: (v) => v * 10000, fromBase: (v) => v / 10000 },
  ha: { category: "area", name: "Hektar", symbol: "ha", toBase: (v) => v * 10000, fromBase: (v) => v / 10000 },
  donum: { category: "area", name: "Dönüm", symbol: "dönüm", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  dönüm: { category: "area", name: "Dönüm", symbol: "dönüm", toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },

  // Time (Base: Seconds)
  s: { category: "time", name: "Saniye", symbol: "s", toBase: (v) => v, fromBase: (v) => v },
  sec: { category: "time", name: "Saniye", symbol: "s", toBase: (v) => v, fromBase: (v) => v },
  second: { category: "time", name: "Saniye", symbol: "s", toBase: (v) => v, fromBase: (v) => v },
  seconds: { category: "time", name: "Saniye", symbol: "s", toBase: (v) => v, fromBase: (v) => v },
  saniye: { category: "time", name: "Saniye", symbol: "s", toBase: (v) => v, fromBase: (v) => v },
  sn: { category: "time", name: "Saniye", symbol: "s", toBase: (v) => v, fromBase: (v) => v },
  min: { category: "time", name: "Dakika", symbol: "min", toBase: (v) => v * 60, fromBase: (v) => v / 60 },
  minute: { category: "time", name: "Dakika", symbol: "min", toBase: (v) => v * 60, fromBase: (v) => v / 60 },
  minutes: { category: "time", name: "Dakika", symbol: "min", toBase: (v) => v * 60, fromBase: (v) => v / 60 },
  dakika: { category: "time", name: "Dakika", symbol: "min", toBase: (v) => v * 60, fromBase: (v) => v / 60 },
  dk: { category: "time", name: "Dakika", symbol: "min", toBase: (v) => v * 60, fromBase: (v) => v / 60 },
  h: { category: "time", name: "Saat", symbol: "sa", toBase: (v) => v * 3600, fromBase: (v) => v / 3600 },
  hour: { category: "time", name: "Saat", symbol: "sa", toBase: (v) => v * 3600, fromBase: (v) => v / 3600 },
  hours: { category: "time", name: "Saat", symbol: "sa", toBase: (v) => v * 3600, fromBase: (v) => v / 3600 },
  saat: { category: "time", name: "Saat", symbol: "sa", toBase: (v) => v * 3600, fromBase: (v) => v / 3600 },
  sa: { category: "time", name: "Saat", symbol: "sa", toBase: (v) => v * 3600, fromBase: (v) => v / 3600 },
  d: { category: "time", name: "Gün", symbol: "gün", toBase: (v) => v * 86400, fromBase: (v) => v / 86400 },
  day: { category: "time", name: "Gün", symbol: "gün", toBase: (v) => v * 86400, fromBase: (v) => v / 86400 },
  days: { category: "time", name: "Gün", symbol: "gün", toBase: (v) => v * 86400, fromBase: (v) => v / 86400 },
  gun: { category: "time", name: "Gün", symbol: "gün", toBase: (v) => v * 86400, fromBase: (v) => v / 86400 },
  gün: { category: "time", name: "Gün", symbol: "gün", toBase: (v) => v * 86400, fromBase: (v) => v / 86400 },
  w: { category: "time", name: "Hafta", symbol: "hf", toBase: (v) => v * 604800, fromBase: (v) => v / 604800 },
  week: { category: "time", name: "Hafta", symbol: "hf", toBase: (v) => v * 604800, fromBase: (v) => v / 604800 },
  weeks: { category: "time", name: "Hafta", symbol: "hf", toBase: (v) => v * 604800, fromBase: (v) => v / 604800 },
  hafta: { category: "time", name: "Hafta", symbol: "hf", toBase: (v) => v * 604800, fromBase: (v) => v / 604800 },
  hf: { category: "time", name: "Hafta", symbol: "hf", toBase: (v) => v * 604800, fromBase: (v) => v / 604800 },
  month: { category: "time", name: "Ay", symbol: "ay", toBase: (v) => v * 2592000, fromBase: (v) => v / 2592000 },
  months: { category: "time", name: "Ay", symbol: "ay", toBase: (v) => v * 2592000, fromBase: (v) => v / 2592000 },
  ay: { category: "time", name: "Ay", symbol: "ay", toBase: (v) => v * 2592000, fromBase: (v) => v / 2592000 },
  year: { category: "time", name: "Yıl", symbol: "yıl", toBase: (v) => v * 31536000, fromBase: (v) => v / 31536000 },
  years: { category: "time", name: "Yıl", symbol: "yıl", toBase: (v) => v * 31536000, fromBase: (v) => v / 31536000 },
  yil: { category: "time", name: "Yıl", symbol: "yıl", toBase: (v) => v * 31536000, fromBase: (v) => v / 31536000 },
  yıl: { category: "time", name: "Yıl", symbol: "yıl", toBase: (v) => v * 31536000, fromBase: (v) => v / 31536000 },
};

// -----------------------------------------------------------------------------
// Live Rate Fetching & Caching
// -----------------------------------------------------------------------------
let liveRates: ExchangeRates = { ...DEFAULT_RATES };
let lastRatesFetch = 0;

export async function initRatesUpdater() {
  const now = Date.now();
  if (now - lastRatesFetch < 3600 * 1000) return; // 1 hour cache

  // 1. Try local storage cache
  try {
    const cached = localStorage.getItem("localmind_rates_cache");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.timestamp && now - parsed.timestamp < 3600 * 1000 && parsed.rates) {
        liveRates = { ...DEFAULT_RATES, ...parsed.rates };
        lastRatesFetch = parsed.timestamp;
        return;
      }
    }
  } catch {
    /* noop */
  }

  // 2. Fetch fresh rates from public open API in background
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.rates) {
        liveRates = {
          ...liveRates,
          ...data.rates,
        };
        lastRatesFetch = now;
        try {
          localStorage.setItem(
            "localmind_rates_cache",
            JSON.stringify({ timestamp: now, rates: liveRates }),
          );
        } catch {
          /* noop */
        }
      }
    }
  } catch {
    /* fallback to offline rates silently */
  }
}

// -----------------------------------------------------------------------------
// Number Formatter
// -----------------------------------------------------------------------------
function formatConvNumber(num: number): string {
  if (Math.abs(num) >= 1000) {
    return num.toLocaleString("tr-TR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }
  if (Math.abs(num) >= 1) {
    return num.toLocaleString("tr-TR", { maximumFractionDigits: 4, minimumFractionDigits: 2 });
  }
  if (Math.abs(num) >= 0.0001) {
    return num.toLocaleString("tr-TR", { maximumFractionDigits: 6 });
  }
  return num.toString();
}

// -----------------------------------------------------------------------------
// Main Parser: parseConverterQuery
// -----------------------------------------------------------------------------
export function parseConverterQuery(rawQuery: string): SearchResult | null {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 2) return null;

  // Pattern 1: Symbol prefix e.g. "$100 to try", "€50 in usd", "₺1000 to eur", "100$ in tl"
  const symbolMatch = query.match(/^([$€₺£¥₿Ξ])\s*([0-9.,]+)\s*(?:to|in|=|->|kaç|kac|ne\s*kadar)?\s*([a-z0-9ğüşıöç₺$€£¥]+)$/i) ||
                      query.match(/^([0-9.,]+)\s*([$€₺£¥₿Ξ])\s*(?:to|in|=|->|kaç|kac|ne\s*kadar)?\s*([a-z0-9ğüşıöç₺$€£¥]+)$/i);

  if (symbolMatch) {
    const isPrefix = Boolean(query.match(/^[$€₺£¥₿Ξ]/));
    const symbol = isPrefix ? symbolMatch[1] : symbolMatch[2];
    const amountStr = isPrefix ? symbolMatch[2] : symbolMatch[1];
    const toUnitRaw = isPrefix ? symbolMatch[3] : symbolMatch[3];
    const amount = parseFloat(amountStr.replace(/\./g, "").replace(",", "."));

    if (!isNaN(amount) && amount > 0) {
      const fromCurr = CURRENCY_ALIASES[symbol];
      const toCurr = CURRENCY_ALIASES[toUnitRaw];
      if (fromCurr && toCurr) {
        return convertCurrencies(amount, fromCurr, toCurr);
      }
    }
  }

  // Pattern 2: "<amount> <from_unit> (to|in|=|->|kac|kaç) <to_unit>"
  // e.g. "100 usd to try", "50 km in miles", "1 btc to usd", "100 f to c", "1024 mb in gb"
  const standardMatch = query.match(
    /^([0-9.,]+)\s*([a-z0-9/²³°"ğüşıöç₺$€£¥₿Ξ]+)\s*(?:to|in|=|->|kaç|kac|kadar|çevir|cevir)?\s*([a-z0-9/²³°"ğüşıöç₺$€£¥₿Ξ]+)$/i,
  );

  if (standardMatch) {
    const amount = parseFloat(standardMatch[1].replace(/\./g, "").replace(",", "."));
    const fromUnitRaw = standardMatch[2].toLowerCase();
    const toUnitRaw = standardMatch[3].toLowerCase();

    if (!isNaN(amount) && amount > 0) {
      // 1. Try Currency & Crypto
      const fromCurr = CURRENCY_ALIASES[fromUnitRaw];
      const toCurr = CURRENCY_ALIASES[toUnitRaw];
      if (fromCurr && toCurr) {
        return convertCurrencies(amount, fromCurr, toCurr);
      }

      // 2. Try Physical & Digital Units
      const fromUnit = UNIT_TABLE[fromUnitRaw];
      const toUnit = UNIT_TABLE[toUnitRaw];
      if (fromUnit && toUnit && fromUnit.category === toUnit.category) {
        return convertUnits(amount, fromUnit, toUnit);
      }
    }
  }

  // Pattern 3: Question format e.g. "100 dolar kaç tl", "50 euro kaç usd", "1 bitcoin kaç tl"
  const questionMatch = query.match(/^([0-9.,]+)\s*([a-zğüşıöç]+)\s*(?:kaç|kac|ne\s*kadar)\s*([a-zğüşıöç]+)$/i);
  if (questionMatch) {
    const amount = parseFloat(questionMatch[1].replace(/\./g, "").replace(",", "."));
    const fromCurr = CURRENCY_ALIASES[questionMatch[2]];
    const toCurr = CURRENCY_ALIASES[questionMatch[3]];
    if (!isNaN(amount) && amount > 0 && fromCurr && toCurr) {
      return convertCurrencies(amount, fromCurr, toCurr);
    }
  }

  return null;
}

function convertCurrencies(amount: number, from: string, to: string): SearchResult {
  const fromRate = liveRates[from] ?? DEFAULT_RATES[from] ?? 1.0;
  const toRate = liveRates[to] ?? DEFAULT_RATES[to] ?? 1.0;

  // Convert via USD base: amount / fromRate * toRate
  const resultVal = (amount / fromRate) * toRate;
  const singleRate = (1 / fromRate) * toRate;

  const fromSymbol = CURRENCY_SYMBOLS[from] || from;
  const toSymbol = CURRENCY_SYMBOLS[to] || to;

  const formattedResult = formatConvNumber(resultVal);
  const formattedSingle = formatConvNumber(singleRate);
  const formattedAmount = amount.toLocaleString("en-US");

  const title = `${formattedAmount} ${from} = ${formattedResult} ${to}`;
  const snippet = `1 ${from} = ${formattedSingle} ${to} (${fromSymbol} → ${toSymbol}) • Live Exchange Rate • Press Enter to copy`;

  return {
    fileName: title,
    filePath: `${formattedResult} ${to}`,
    snippet,
    score: 1.0,
    category: "converter",
    action: "copy",
    actionTitle: "Copy Result to Clipboard",
  };
}

function convertUnits(amount: number, from: UnitDef, to: UnitDef): SearchResult {
  const baseVal = from.toBase(amount);
  const resultVal = to.fromBase(baseVal);

  const formattedResult = formatConvNumber(resultVal);
  const formattedAmount = amount.toLocaleString("en-US");

  const title = `${formattedAmount} ${from.symbol} = ${formattedResult} ${to.symbol}`;
  const snippet = `${from.name} → ${to.name} (${from.category.toUpperCase()}) • Press Enter to copy`;

  return {
    fileName: title,
    filePath: `${formattedResult} ${to.symbol}`,
    snippet,
    score: 1.0,
    category: "converter",
    action: "copy",
    actionTitle: "Copy Result to Clipboard",
  };
}
