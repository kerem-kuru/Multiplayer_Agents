/**
 * gitleaks kural setini içeri al → packages/redact/src/rules.generated.ts
 *
 *   node scripts/import-gitleaks.mjs [--file <yerel toml>] [--url <adres>]
 *
 * NEDEN ÜRETİLMİŞ DOSYA REPODA: build sırasında ağ erişimi gerekmesin. Kural
 * seti güncellemek isteyen bu script'i elle koşar, çıktıyı commit'ler.
 *
 * Go RE2 → JS RegExp: gitleaks kuralları RE2 sözdiziminde. Node'un
 * desteklemediği yapıları ATLIYORUZ ve raporluyoruz — elle uydurmak, kuralın
 * ne yakaladığını sessizce değiştirmek demek olurdu.
 */
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL =
  "https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml";
const OUT = path.join(ROOT, "packages/redact/src/rules.generated.ts");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/**
 * RE2'de olup JS'te olmayan (veya JS'te SESSİZCE başka anlama gelen) yapılar.
 * Sessiz anlam değişimi en tehlikelisi: `\z` JS'te sadece "z" harfidir, hata
 * vermez — kural derlenir ama yanlış şeyi arar.
 */
const UNSUPPORTED = [
  { re: /\(\?P</, why: "adlandırılmış grup (?P<...>)" },
  { re: /\(\?>/, why: "atomik grup (?>...)" },
  { re: /\(\?U\)|\(\?s\)|\(\?m\)|\(\?im\)|\(\?is\)/, why: "satır içi bayrak (i dışında)" },
];

/**
 * `\A` ve `\z` JS'te YOK ama birebir karşılıkları var: `m` bayrağı olmadan
 * `^` girdinin başı, `$` girdinin SONUDUR (Python'un aksine son satır sonundan
 * önce eşleşmez). RE2'nin `\A`/`\z` anlamı tam olarak budur, yani bu çeviri
 * kuralın ne aradığını değiştirmiyor. Bunları atlasaydık kural setinin yarısını
 * kaybederdik.
 *
 * İKİ İSTİSNA, ikisi de atlanır:
 *  - karakter sınıfı içindeki `\A`/`\z` (orada `^`/`$` düz karakter olurdu),
 *  - kaçırılmış ters bölü (`\z` = ters bölü + 'z' harfi).
 */
function translateAnchors(pattern) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if ((next === "A" || next === "z") && !inClass) {
        out += next === "A" ? "^" : "$";
        i++;
        continue;
      }
      if ((next === "A" || next === "z") && inClass) {
        return { skip: `karakter sınıfı içinde \${next}` };
      }
      out += ch + (next ?? "");
      i++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    out += ch;
  }
  return { pattern: out };
}

/** `(?i)` SADECE desenin başındaysa `i` bayrağına yükseltilebilir. */
function toJsRegex(source) {
  let flags = "gd";
  let pattern = source;

  const inline = [...pattern.matchAll(/\(\?i\)/g)];
  if (inline.length > 0) {
    if (inline.length === 1 && inline[0].index === 0) {
      pattern = pattern.slice(4);
      flags += "i";
    } else {
      return { skip: "(?i) desenin ortasında — JS satır içi bayrak desteklemiyor" };
    }
  }

  for (const { re, why } of UNSUPPORTED) {
    if (re.test(pattern)) return { skip: why };
  }

  const anchored = translateAnchors(pattern);
  if (anchored.skip) return { skip: anchored.skip };
  pattern = anchored.pattern;

  try {
    // Derlenmiyorsa zaten bizim için yok.
    new RegExp(pattern, flags);
  } catch (err) {
    return { skip: `derlenmedi: ${err.message}` };
  }
  return { pattern, flags };
}

const toml = arg("file")
  ? await readFile(arg("file"), "utf8")
  : await fetch(arg("url") ?? DEFAULT_URL).then((r) => {
      if (!r.ok) throw new Error(`indirilemedi: ${r.status}`);
      return r.text();
    });

const parsed = parseToml(toml);
const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
if (rules.length === 0) throw new Error("toml içinde [[rules]] yok");

const kept = [];
const skipped = [];

for (const rule of rules) {
  const id = String(rule.id ?? "").trim();
  const source = typeof rule.regex === "string" ? rule.regex : "";
  if (!id || !source) {
    skipped.push({ id: id || "(isimsiz)", why: "regex alanı yok" });
    continue;
  }
  const converted = toJsRegex(source);
  if (converted.skip) {
    skipped.push({ id, why: converted.skip });
    continue;
  }
  kept.push({
    id,
    pattern: converted.pattern,
    flags: converted.flags,
    // Anahtar kelime ön filtresi: ucuz `includes` geçmezse pahalı regex hiç koşmaz.
    keywords: Array.isArray(rule.keywords) ? rule.keywords.map((k) => String(k).toLowerCase()) : [],
    entropy: typeof rule.entropy === "number" ? rule.entropy : undefined,
    secretGroup: typeof rule.secretGroup === "number" ? rule.secretGroup : undefined,
  });
}

const version = String(parsed.minVersion ?? "bilinmiyor");
const bugun = new Date().toISOString().slice(0, 10);

const body = kept
  .map((r) => {
    const parts = [
      `id: ${JSON.stringify(r.id)}`,
      `pattern: ${JSON.stringify(r.pattern)}`,
      `flags: ${JSON.stringify(r.flags)}`,
      `keywords: ${JSON.stringify(r.keywords)}`,
    ];
    if (r.entropy !== undefined) parts.push(`entropy: ${r.entropy}`);
    if (r.secretGroup !== undefined) parts.push(`secretGroup: ${r.secretGroup}`);
    return `  { ${parts.join(", ")} },`;
  })
  .join("\n");

const out = `// ÜRETİLMİŞ DOSYA — ELLE DÜZENLEME.
// Üreten:  scripts/import-gitleaks.mjs
// Kaynak:  ${arg("url") ?? DEFAULT_URL}
// gitleaks minVersion: ${version}
// İndirme tarihi: ${bugun}
// Kural: ${kept.length} alındı, ${skipped.length} atlandı (RE2 → JS çevrilemedi).
//
// Güncellemek için: node scripts/import-gitleaks.mjs && npm run build
import type { RuleSpec } from "./rule-types.js";

export const GENERATED_RULES: readonly RuleSpec[] = [
${body}
];
`;

await writeFile(OUT, out, "utf8");

console.log(`alınan kural : ${kept.length}`);
console.log(`atlanan kural: ${skipped.length}`);
const byReason = new Map();
for (const s of skipped) byReason.set(s.why, (byReason.get(s.why) ?? 0) + 1);
for (const [why, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} × ${why}`);
}
if (skipped.length > 0) {
  console.log("\natlananlar:");
  for (const s of skipped) console.log(`  ${s.id} — ${s.why}`);
}
console.log(`\nyazıldı: ${path.relative(ROOT, OUT)}`);
