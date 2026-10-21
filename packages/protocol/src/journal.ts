import { z } from "zod";
import { AgentName } from "./ids.js";

/**
 * Oda defteri — Hafta 8.
 *
 * Agent'lar arasındaki TEK koordinasyon kanalı. Bir sohbet değil, bir veri
 * yapısı: serbest metin girmez, her kayıt bu şemadan geçer. Geçmeyen kayıt
 * yazılmaz; çağıran agent'a ne beklendiğini söyleyen bir hata döner.
 *
 * Defter dosya içeriğini kopyalamaz. Sözleşmenin KENDİSİ `contracts/`'ta
 * (Hafta 7); defter niyeti, durumu ve kararın gerekçesini taşır ve dosyaya
 * `Contract.file` ile işaret eder.
 */

export const JournalStatus = z.enum(["in_progress", "blocked", "waiting_review", "done", "idle"]);
export type JournalStatus = z.infer<typeof JournalStatus>;

/**
 * Adlar burada yalnızca biçimce doğrulanır. "Bu adda bir agent var mı" sorusu
 * oda config'ine bağlı ve `parseJournalPatch` içinde soruluyor.
 */
const AgentRefName = z.string().min(1).max(32);

export const Decision = z.object({
  /** "JWT yerine session cookie" */
  what: z.string().min(3).max(200),
  /** "frontend SSR gerektiriyor" */
  why: z.string().min(3).max(300),
  /** Etkilenen agent adları. */
  affects: z.array(AgentRefName).max(5).default([]),
});
export type Decision = z.infer<typeof Decision>;

export const Contract = z.object({
  /** "POST /api/login" — sözleşmenin kimliği; birleştirme bu ada göre. */
  name: z.string().min(1).max(120),
  /** "-> {token, expiresAt}" veya şema özeti. */
  shape: z.string().min(1).max(400),
  /** "contracts/auth.md" — içerik orada, defterde değil. */
  file: z.string().max(200).nullable().default(null),
  stability: z.enum(["draft", "agreed"]).default("draft"),
});
export type Contract = z.infer<typeof Contract>;

export const JOURNAL_LIMITS = {
  decisions: 10,
  contracts: 10,
  touched: 50,
  needsFrom: 5,
} as const;

export const JournalEntry = z.object({
  /** Host doldurur; agent'tan gelen yok sayılır. */
  agent: AgentName,
  /** Hafta 8'de serbest etiket; Hafta 9'da görev kaydına bağlanacak. */
  task: z.string().max(80).nullable().default(null),
  status: JournalStatus,
  /** Kartta görünen tek satır (Hafta 7'deki `card.line`'ın yeni kaynağı). */
  headline: z.string().min(3).max(100),
  /** Host doldurur — event log'dan, mekanik. */
  touched: z.array(z.string()).max(JOURNAL_LIMITS.touched).default([]),
  decisions: z.array(Decision).max(JOURNAL_LIMITS.decisions).default([]),
  contracts: z.array(Contract).max(JOURNAL_LIMITS.contracts).default([]),
  blocked_on: z.string().max(200).nullable().default(null),
  /** Agent adları; config'te var olmalı. */
  needs_from: z.array(AgentRefName).max(JOURNAL_LIMITS.needsFrom).default([]),
  /** Host doldurur. Agent başına 1, 2, 3… */
  version: z.number().int().positive(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/**
 * Host'un doldurduğu alanlar. `write_summary` payload'ında gelirlerse YOK
 * SAYILIR (reddedilmez): agent'ın bunları göndermesi bir hata değil, sadece
 * etkisiz. Kimlik host'ta bilinir; payload'daki `agent`'a güvenilmez.
 */
export const JOURNAL_HOST_FIELDS = ["agent", "touched", "version"] as const;

/**
 * Agent'ın (ve otomatik özetin) yazabildiği alanlar. Hepsi isteğe bağlı:
 * gönderilmeyen alan önceki kayıttan devralınır (`mergeJournalEntry`).
 *
 * `.strict()`: bilinmeyen bir anahtar ("decision", "summary") REDDEDİLİR.
 * Sessizce atılsaydı agent yazdığını sanır, bilgi kaybolurdu.
 */
export const JournalPatch = z
  .object({
    task: JournalEntry.shape.task.removeDefault().optional(),
    status: JournalStatus.optional(),
    headline: JournalEntry.shape.headline.optional(),
    decisions: z.array(Decision).max(JOURNAL_LIMITS.decisions).optional(),
    contracts: z.array(Contract).max(JOURNAL_LIMITS.contracts).optional(),
    blocked_on: JournalEntry.shape.blocked_on.removeDefault().optional(),
    needs_from: z.array(AgentRefName).max(JOURNAL_LIMITS.needsFrom).optional(),
    /** Bir sözleşmeyi kaldırmanın tek yolu: adını buraya yazmak. */
    remove_contracts: z.array(z.string().min(1).max(120)).max(JOURNAL_LIMITS.contracts).optional(),
  })
  .strict();
export type JournalPatch = z.infer<typeof JournalPatch>;

/**
 * `write_summary` payload'ını doğrular.
 *
 * 1. Host alanları atılır.
 * 2. Şema (bilinmeyen anahtar reddedilir).
 * 3. `needs_from` ve `decisions[].affects`'teki her ad config'teki bir agent
 *    olmalı — yazım hatası ("fronted") sessizce kaybolmasın.
 */
export function parseJournalPatch(input: unknown, opts: { agents: readonly string[] }) {
  const known = new Set(opts.agents);
  const stripped =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(
          Object.entries(input).filter(([k]) => !(JOURNAL_HOST_FIELDS as readonly string[]).includes(k)),
        )
      : input;
  return JournalPatch.superRefine((p, ctx) => {
    const unknownName = (name: string, path: (string | number)[]) => {
      if (!known.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `"${name}" bu odada bir agent değil. Geçerli adlar: ${[...known].join(", ")}`,
        });
      }
    };
    p.needs_from?.forEach((n, i) => unknownName(n, ["needs_from", i]));
    p.decisions?.forEach((d, i) => d.affects.forEach((n, j) => unknownName(n, ["decisions", i, "affects", j])));
  }).safeParse(stripped);
}

/** Hatanın dokunduğu üst düzey alanlar — `journal.rejected.fields` için. */
export function journalErrorFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    // `.strict()` bilinmeyen anahtarı yolda değil `keys`'te bildiriyor.
    if (issue.code === z.ZodIssueCode.unrecognized_keys) issue.keys.forEach((k) => fields.add(k));
    else fields.add(issue.path.length > 0 ? String(issue.path[0]) : "(kayıt)");
  }
  return [...fields].sort();
}

export type JournalHostFields = {
  agent: string;
  version: number;
  touched: string[];
};

/**
 * Önceki kayıt + yama + host alanları → yeni kayıt. SAF; DB'ye dokunmaz.
 *
 * Birleştirme kuralları (görev tanımı Adım 1):
 * - Gönderilmeyen alan önceki kayıttan devralınır.
 * - `decisions` BİRİKİMLİ: yeniler öncekilerin sonuna eklenir, aynı `what`
 *   yenisiyle değişir. Üst sınır aşılırsa EN ESKİ düşer (en yeni 10 kalır).
 * - `contracts` BİRİKİMLİ: önceki liste taşınır, aynı `name` yenisiyle
 *   değişir. `remove_contracts` önce uygulanır. Sözleşme SESSİZCE DÜŞMEZ:
 *   10'u aşan birleşim hata verir — koordinasyonun taşıyıcısı onlar.
 * - `remove_contracts`'ta önceki kayıtta olmayan ad hatadır (yazım hatası).
 *
 * Sonuç `JournalEntry.safeParse`'tan geçer; ilk kayıtta `status` ve
 * `headline` yoksa hata buradan çıkar.
 */
export function mergeJournalEntry(
  prev: JournalEntry | null,
  patch: JournalPatch,
  host: JournalHostFields,
): z.SafeParseReturnType<unknown, JournalEntry> {
  const removes = patch.remove_contracts ?? [];
  const prevContracts = prev?.contracts ?? [];
  const missing = removes
    .map((name, i) => ({ name, i }))
    .filter(({ name }) => !prevContracts.some((c) => c.name === name));
  if (missing.length > 0) {
    return {
      success: false,
      error: new z.ZodError(
        missing.map(({ name, i }) => ({
          code: z.ZodIssueCode.custom,
          path: ["remove_contracts", i],
          message: `"${name}" adında bir sözleşme yok. Mevcut: ${prevContracts.map((c) => c.name).join(", ") || "(hiç)"}`,
        })),
      ),
    };
  }

  const contracts = prevContracts.filter((c) => !removes.includes(c.name));
  for (const c of patch.contracts ?? []) {
    const at = contracts.findIndex((x) => x.name === c.name);
    if (at >= 0) contracts[at] = c;
    else contracts.push(c);
  }

  let decisions = prev?.decisions ?? [];
  if (patch.decisions) {
    const incoming = new Set(patch.decisions.map((d) => d.what));
    decisions = [...decisions.filter((d) => !incoming.has(d.what)), ...patch.decisions].slice(
      -JOURNAL_LIMITS.decisions,
    );
  }

  const pick = <K extends "task" | "status" | "headline" | "blocked_on" | "needs_from">(k: K) =>
    patch[k] !== undefined ? patch[k] : prev?.[k];

  return JournalEntry.safeParse({
    agent: host.agent,
    task: pick("task"),
    status: pick("status"),
    headline: pick("headline"),
    touched: host.touched.slice(0, JOURNAL_LIMITS.touched),
    decisions,
    contracts,
    blocked_on: pick("blocked_on"),
    needs_from: pick("needs_from"),
    version: host.version,
  });
}
