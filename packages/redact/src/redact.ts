import { createHash } from "node:crypto";
import { scanEntropy } from "./entropy.js";
import { compileRules, type CompiledRule, candidateRules } from "./rules.js";
import { shannonEntropy } from "./entropy.js";

/**
 * Redaction motoru — event log'a YAZILMADAN ÖNCE çalışır.
 *
 * Filtreyi görüntüleme anına bırakmak, secret'ı veritabanında, yedeklerde,
 * replay'de ve denetim çıktısında bırakmak demektir. Append-only bir log'dan
 * sonradan silmek mümkün değil: temiz veri sakla.
 */

export interface Finding {
  /** Kural adı: "aws-access-token" | "entropy" | "oversized" | ... */
  rule: string;
  /** Payload içindeki JSON yolu: "output", "input.command", "items.2.output" */
  path: string;
  /** sha256(secret) ilk 8 hex — bulgu kaydı ASLA ham secret içermez. */
  hash8: string;
  /** Orijinal uzunluk. */
  length: number;
}

export interface RedactOptions {
  /** Oda YAML'ındaki `redaction.allow_patterns`. */
  allowPatterns?: readonly RegExp[];
  /** Testler için kural setini daraltmak. */
  rules?: readonly CompiledRule[];
}

/** Bu boyutun üstü taranmaz — taranmayan kısım da saklanmaz. */
export const MAX_SCAN_BYTES = 256 * 1024;

const RULES = compileRules();

export function hash8(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8);
}

export function marker(rule: string, secret: string): string {
  // Aynı secret her yerde aynı işareti alır: "aynı anahtar iki yerde geçmiş"
  // bilgisi korunur, değerin kendisi kaybolur.
  return `[redacted:${rule}:${hash8(secret)}]`;
}

interface Span {
  start: number;
  end: number;
  rule: string;
}

/** Kural setinden gelen eşleşmeler. */
function ruleSpans(text: string, rules: readonly CompiledRule[]): Span[] {
  const spans: Span[] = [];

  for (const { spec, regex } of candidateRules(text, rules)) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const group = spec.secretGroup;
      let start: number;
      let end: number;

      if (group !== undefined && match.indices?.[group]) {
        [start, end] = match.indices[group]!;
      } else {
        start = match.index ?? 0;
        end = start + match[0].length;
      }
      if (end <= start) continue;

      const secret = text.slice(start, end);
      // Kuralın kendi entropi eşiği varsa (gitleaks'ten gelir) uygula:
      // "TOKEN=xxxxxxxxxxxx" gibi yer tutucuları maskelememek için.
      if (spec.entropy !== undefined && shannonEntropy(secret) < spec.entropy) continue;

      spans.push({ start, end, rule: spec.id });
    }
  }

  return spans;
}

/**
 * Çakışmaları çöz: EN UZUN eşleşme kazanır.
 *
 * Aynı yeri iki kural yakaladığında daha geniş olanı almak, secret'ın bir
 * parçasının açıkta kalmasını engeller.
 */
function resolveOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const chosen: Span[] = [];
  for (const span of sorted) {
    if (chosen.some((c) => span.start < c.end && c.start < span.end)) continue;
    chosen.push(span);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export function redactValue(
  text: string,
  options: RedactOptions = {},
): { text: string; findings: Finding[] } {
  if (text.length === 0) return { text, findings: [] };

  const findings: Finding[] = [];
  let scanned = text;
  let tail = "";

  if (text.length > MAX_SCAN_BYTES) {
    scanned = text.slice(0, MAX_SCAN_BYTES);
    const rest = text.slice(MAX_SCAN_BYTES);
    tail = "[redacted:oversized]";
    findings.push({
      rule: "oversized",
      path: "",
      hash8: hash8(rest),
      length: rest.length,
    });
  }

  const rules = options.rules ?? RULES;
  const spans = ruleSpans(scanned, rules);

  for (const hit of scanEntropy(scanned, { allowPatterns: options.allowPatterns })) {
    spans.push({ start: hit.index, end: hit.index + hit.value.length, rule: "entropy" });
  }

  const chosen = resolveOverlaps(spans);
  if (chosen.length === 0) return { text: scanned + tail, findings };

  let out = "";
  let cursor = 0;
  for (const span of chosen) {
    const secret = scanned.slice(span.start, span.end);
    out += scanned.slice(cursor, span.start) + marker(span.rule, secret);
    cursor = span.end;
    findings.push({ rule: span.rule, path: "", hash8: hash8(secret), length: secret.length });
  }
  out += scanned.slice(cursor);

  return { text: out + tail, findings };
}

/**
 * Nesneyi özyinelemeli gez, SADECE string değerleri temizle.
 *
 * Anahtar isimlerine dokunulmaz: `DB_PASSWORD` anahtarının kendisi bilgi
 * taşır, değeri taşımamalı.
 */
export function redactPayload(
  payload: unknown,
  options: RedactOptions = {},
): { payload: unknown; findings: Finding[] } {
  const findings: Finding[] = [];

  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      const result = redactValue(value, options);
      for (const f of result.findings) findings.push({ ...f, path });
      return result.text;
    }
    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(item, path ? `${path}.${key}` : key);
      }
      return out;
    }
    return value;
  };

  return { payload: walk(payload, ""), findings };
}

/** Oda YAML'ındaki desenleri RegExp'e çevir — bozuk desen sessizce atlanır. */
export function compileAllowPatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p));
    } catch {
      // Bozuk desen yüzünden redaction'ın tamamı çökmemeli.
    }
  }
  return out;
}
