import type { RuleSpec } from "./rule-types.js";
import { GENERATED_RULES } from "./rules.generated.js";

/**
 * Elle eklenen kurallar — gitleaks'te olmayan ya da bize özgü olanlar.
 * Üretilen listeden ÖNCE gelirler: aynı uzunlukta çakışan eşleşmede bizim
 * verdiğimiz isim kazanır, bulgu okunur kalır.
 */
export const MANUAL_RULES: readonly RuleSpec[] = [
  {
    id: "anthropic-api-key",
    pattern: "sk-ant-[A-Za-z0-9_-]{16,}",
    flags: "gd",
    keywords: ["sk-ant"],
  },
  {
    // Oda davet linki — çok kullanımlık, süreli. Sohbete veya log'a düşerse
    // odaya izinsiz giriş demek.
    id: "rooms-invite-token",
    pattern: "(?:join|invite|invites)[^\s]*[?&]token=([A-Za-z0-9_-]{20,})",
    flags: "gdi",
    keywords: ["token="],
    secretGroup: 1,
  },
  {
    // Magic link — tek kullanımlık ama 15 dk boyunca o kişinin oturumu.
    id: "rooms-magic-link",
    pattern: "auth/callback[^\s]*[?&]token=([A-Za-z0-9_-]{20,})",
    flags: "gdi",
    keywords: ["token="],
    secretGroup: 1,
  },
  {
    // `.env` satır formatı. Anahtar adı EKRANDA KALIR, değer maskelenir:
    // "DB_PASSWORD=[redacted:...]" okunabilir, "satır silindi" değil.
    id: "env-assignment",
    pattern: "^[A-Z][A-Z0-9_]{3,}=(.{8,})$",
    flags: "gdm",
    keywords: [],
    secretGroup: 1,
  },
];

/**
 * Elle yazılan kurallar üretilenleri EZER: aynı id iki listede de olabilir
 * (gitleaks'in `anthropic-api-key`'i gibi). Bizimki önde durur, çünkü bulgu
 * adını ve secretGroup'unu biz biliyoruz.
 */
const MANUAL_IDS = new Set(MANUAL_RULES.map((r) => r.id));

export const ALL_RULES: readonly RuleSpec[] = [
  ...MANUAL_RULES,
  ...GENERATED_RULES.filter((r) => !MANUAL_IDS.has(r.id)),
];

/** Derlenmiş kural — regex nesnesi kurulum anında bir kez yaratılır. */
export interface CompiledRule {
  spec: RuleSpec;
  regex: RegExp;
}

export function compileRules(specs: readonly RuleSpec[] = ALL_RULES): CompiledRule[] {
  return specs.map((spec) => ({ spec, regex: new RegExp(spec.pattern, spec.flags) }));
}

/**
 * ÖN FİLTRE — performansın tamamı buradan geliyor.
 *
 * Bir kuralın anahtar kelimelerinden hiçbiri metinde geçmiyorsa regex HİÇ
 * çalıştırılmaz. 198 kuralın regex'ini her 16 KB metinde koşturmak milisaniye
 * değil, on milisaniyeler demek; `includes` taraması ise neredeyse bedava.
 */
export function candidateRules(text: string, rules: readonly CompiledRule[]): CompiledRule[] {
  const haystack = text.toLowerCase();
  return rules.filter(
    (r) => r.spec.keywords.length === 0 || r.spec.keywords.some((k) => haystack.includes(k)),
  );
}
