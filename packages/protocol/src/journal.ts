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
 *
 * İKİ PARÇALI MODEL (21 Ekim düzeltmesi):
 *
 * - **Anlık kısım** (`JournalSnapshot`): agent başına, "şu an ne yapıyorum".
 *   Her yazım yeni bir sürüm üretir; yazımda olmayan alan önceki sürümden
 *   korunur.
 * - **Sicil** (`DecisionRecord`, `Contract`): oda düzeyinde, birikimli. Yazımda
 *   olmayan şey eklenmez ve HİÇBİR ŞEY DÜŞMEZ. Eski tasarım 10 kararı aşınca en
 *   eskiyi atıyordu; uzun bir projede agent'ın bağlamı kayınca kaybolan bilgi
 *   tam olarak oydu. Artık sicilin toplam sınırı yok — `JOURNAL_LIMITS` tek
 *   yazımın sınırı. Sicil büyüyünce ne gösterileceğine `relevantDecisions`
 *   (model çağrısı yok, deterministik) karar verir; eşik aşılınca
 *   `journalCompaction` ölçüm üretir — sıkıştırma kararı (Hafta 11) tahmine
 *   değil bu ölçüme dayanacak.
 */

export const JournalStatus = z.enum(["in_progress", "blocked", "waiting_review", "done", "idle"]);
export type JournalStatus = z.infer<typeof JournalStatus>;

/**
 * Adlar burada yalnızca biçimce doğrulanır. "Bu adda bir agent var mı" sorusu
 * oda config'ine bağlı ve `parseJournalPatch` içinde soruluyor.
 */
const AgentRefName = z.string().min(1).max(32);

export const Decision = z.object({
  /** "JWT yerine session cookie" — sahibinin sicilinde kimlik bu. */
  what: z.string().min(3).max(200),
  /** "frontend SSR gerektiriyor" */
  why: z.string().min(3).max(300),
  /** Etkilenen agent adları. Boş: odanın geneli (herkese gösterilir). */
  affects: z.array(AgentRefName).max(5).default([]),
});
export type Decision = z.infer<typeof Decision>;

/** Sicildeki karar: kim yazdı, defterin hangi sürümünde. İkisini host doldurur. */
export const DecisionRecord = Decision.extend({
  owner: AgentName,
  version: z.number().int().positive(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const Contract = z.object({
  /** "POST /api/login" — sözleşmenin oda içindeki kimliği. */
  name: z.string().min(1).max(120),
  /** "-> {token, expiresAt}" veya şema özeti. */
  shape: z.string().min(1).max(400),
  /** "contracts/auth.md" — içerik orada, defterde değil. */
  file: z.string().max(200).nullable().default(null),
  stability: z.enum(["draft", "agreed"]).default("draft"),
  /**
   * Host doldurur: yazan agent. Değiştirme ve kaldırma yalnızca sahibine açık
   * (Değişmez Kural 5 sicile de uzanıyor).
   */
  owner: AgentName,
  /**
   * Host doldurur: `file`'ın yazım anındaki sha256'sı. Dosya sonradan değişir
   * de sicil güncellenmezse oda durumu metni "(dosya değişmiş)" der. `file`
   * yoksa ya da yazım anında dosya yoksa null.
   */
  sourceSha256: Sha256.nullable().default(null),
});
export type Contract = z.infer<typeof Contract>;

/**
 * Payload'daki sözleşme: host alanları yok. Nesne `.strict()` değil, bu yüzden
 * gelen `owner` / `sourceSha256` reddedilmez, SESSİZCE ATILIR — üst düzeydeki
 * `agent`/`touched`/`version` gibi: göndermek hata değil, sadece etkisiz.
 */
export const ContractInput = Contract.omit({ owner: true, sourceSha256: true });
export type ContractInput = z.infer<typeof ContractInput>;

/** TEK YAZIMIN sınırları. Sicilin (odanın) toplamı sınırsız. */
export const JOURNAL_LIMITS = {
  decisions: 10,
  contracts: 10,
  removeContracts: 10,
  touched: 50,
  needsFrom: 5,
} as const;

/** Anlık kısım: agent başına bir güncel sürüm. Kararlar ve sözleşmeler burada değil. */
export const JournalSnapshot = z.object({
  /** Host doldurur; agent'tan gelen yok sayılır. */
  agent: AgentName,
  /** Hafta 8'de serbest etiket; Hafta 9'da görev kaydına bağlanacak. */
  task: z.string().max(80).nullable().default(null),
  status: JournalStatus,
  /** Kartta görünen tek satır (Hafta 7'deki `card.line`'ın yeni kaynağı). */
  headline: z.string().min(3).max(100),
  /** Host doldurur — event log'dan, mekanik. */
  touched: z.array(z.string()).max(JOURNAL_LIMITS.touched).default([]),
  blocked_on: z.string().max(200).nullable().default(null),
  /** Agent adları; config'te var olmalı. */
  needs_from: z.array(AgentRefName).max(JOURNAL_LIMITS.needsFrom).default([]),
  /** Host doldurur. Agent başına 1, 2, 3… */
  version: z.number().int().positive(),
});
export type JournalSnapshot = z.infer<typeof JournalSnapshot>;

/**
 * Host'un doldurduğu üst düzey alanlar. `write_summary` payload'ında
 * gelirlerse YOK SAYILIR (reddedilmez). Kimlik host'ta bilinir; payload'daki
 * `agent`'a güvenilmez.
 */
export const JOURNAL_HOST_FIELDS = ["agent", "touched", "version"] as const;

/**
 * Agent'ın (ve otomatik özetin) yazabildiği alanlar — bir yazımın DELTASI.
 * Hepsi isteğe bağlı.
 *
 * `.strict()`: bilinmeyen bir anahtar ("decision", "summary") REDDEDİLİR.
 * Sessizce atılsaydı agent yazdığını sanır, bilgi kaybolurdu.
 */
export const JournalPatch = z
  .object({
    task: JournalSnapshot.shape.task.removeDefault().optional(),
    status: JournalStatus.optional(),
    headline: JournalSnapshot.shape.headline.optional(),
    blocked_on: JournalSnapshot.shape.blocked_on.removeDefault().optional(),
    needs_from: z.array(AgentRefName).max(JOURNAL_LIMITS.needsFrom).optional(),
    decisions: z.array(Decision).max(JOURNAL_LIMITS.decisions).optional(),
    contracts: z.array(ContractInput).max(JOURNAL_LIMITS.contracts).optional(),
    /** Bir sözleşmeyi kaldırmanın tek yolu: adını buraya yazmak. Yalnızca sahibi. */
    remove_contracts: z.array(z.string().min(1).max(120)).max(JOURNAL_LIMITS.removeContracts).optional(),
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

/** Odanın defter durumu: agent başına anlık kısım + oda sicili. */
export type JournalState = {
  snapshots: Readonly<Record<string, JournalSnapshot>>;
  /** Sıra: yazım sırası (sürüm, sonra payload içi sıra). Aynı sahip+`what` tek. */
  decisions: readonly DecisionRecord[];
  /** Ad oda içinde tek. Sıra: ilk yazım sırası; güncelleme yerinde. */
  contracts: readonly Contract[];
};

export const EMPTY_JOURNAL: JournalState = { snapshots: {}, decisions: [], contracts: [] };

export type JournalHostFields = {
  agent: string;
  version: number;
  /**
   * Bu yazımın turn'ünde değişen dosyalar. Boşsa (ya da yoksa) önceki
   * sürümünki korunur: dosyaya dokunmayan bir yazım "hiçbir şeye dokunmadım"
   * demek değil, "bu yazım dosya bilgisi taşımıyor" demek.
   */
  touched?: readonly string[];
  /** Depo-göreli yolun şu anki sha256'sı; dosya yoksa null. */
  fileSha: (file: string) => string | null;
};

/**
 * Bir yazımın sonucu — DB'ye ve event log'a giden şey. Sicil kısmı DELTA:
 * yalnızca bu yazımın eklediği/değiştirdiği/kaldırdığı öğeler.
 */
export type JournalWrite = {
  snapshot: JournalSnapshot;
  decisions: DecisionRecord[];
  contracts: Contract[];
  removeContracts: string[];
};

/**
 * Önceki durum + yama + host alanları → yazım. SAF; DB'ye dokunmaz.
 *
 * Anlık alanlar (`task`, `status`, `headline`, `blocked_on`, `needs_from`,
 * `touched`): yazımda yoksa önceki sürümden korunur. İlk yazımda `status` ve
 * `headline` yoksa hata.
 *
 * Sicil (`decisions`, `contracts`): yazımda yoksa hiçbir şey eklenmez,
 * hiçbir şey düşmez.
 * - Karar kimliği sahip + `what`; aynısı yenisiyle değişir.
 * - Sözleşme kimliği `name`, oda içinde tek. Başka agent'ın sözleşmesini
 *   değiştirmek ya da kaldırmak hatadır — sahibi `owner`.
 * - `remove_contracts` önce uygulanır; sicilde olmayan ad hatadır (yazım hatası).
 */
export function mergeJournalWrite(
  prev: JournalState,
  patch: JournalPatch,
  host: JournalHostFields,
): z.SafeParseReturnType<unknown, JournalWrite> {
  const issues: z.ZodIssue[] = [];
  const byName = new Map(prev.contracts.map((c) => [c.name, c]));
  const names = () => prev.contracts.map((c) => c.name).join(", ") || "(hiç)";

  const removeContracts = patch.remove_contracts ?? [];
  removeContracts.forEach((name, i) => {
    const c = byName.get(name);
    if (!c) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: ["remove_contracts", i],
        message: `"${name}" adında bir sözleşme yok. Mevcut: ${names()}`,
      });
    } else if (c.owner !== host.agent) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: ["remove_contracts", i],
        message: `"${name}" ${c.owner}'in sözleşmesi; yalnızca o kaldırabilir.`,
      });
    }
  });

  (patch.contracts ?? []).forEach((c, i) => {
    const owner = byName.get(c.name)?.owner;
    if (owner !== undefined && owner !== host.agent) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: ["contracts", i, "name"],
        message: `"${c.name}" ${owner}'in sözleşmesi; yalnızca o değiştirebilir. Farklı bir ad kullan ya da needs_from ile ${owner}'den iste.`,
      });
    }
  });
  if (issues.length > 0) return { success: false, error: new z.ZodError(issues) };

  // Aynı yazımda aynı kimlik iki kez: sonuncusu kazanır.
  const lastBy = <T>(xs: readonly T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];

  const decisions = lastBy(patch.decisions ?? [], (d) => d.what).map((d) =>
    DecisionRecord.parse({ ...d, owner: host.agent, version: host.version }),
  );
  const contracts = lastBy(patch.contracts ?? [], (c) => c.name).map((c) =>
    Contract.parse({ ...c, owner: host.agent, sourceSha256: c.file ? host.fileSha(c.file) : null }),
  );

  const before = prev.snapshots[host.agent];
  const pick = <K extends "task" | "status" | "headline" | "blocked_on" | "needs_from">(k: K) =>
    patch[k] !== undefined ? patch[k] : before?.[k];
  const touched = host.touched && host.touched.length > 0 ? host.touched.slice(0, JOURNAL_LIMITS.touched) : before?.touched;

  const snapshot = JournalSnapshot.safeParse({
    agent: host.agent,
    task: pick("task"),
    status: pick("status"),
    headline: pick("headline"),
    touched,
    blocked_on: pick("blocked_on"),
    needs_from: pick("needs_from"),
    version: host.version,
  });
  if (!snapshot.success) return { success: false, error: snapshot.error };

  return { success: true, data: { snapshot: snapshot.data, decisions, contracts, removeContracts } };
}

/** Yazımı duruma uygula. SAF — projeksiyon ve testler aynı kuralı kullanır. */
export function applyJournalWrite(prev: JournalState, w: JournalWrite): JournalState {
  const agent = w.snapshot.agent;
  const replaced = new Set(w.decisions.map((d) => d.what));
  const decisions = [
    ...prev.decisions.filter((d) => !(d.owner === agent && replaced.has(d.what))),
    ...w.decisions,
  ];

  const contracts = prev.contracts.filter((c) => !w.removeContracts.includes(c.name));
  for (const c of w.contracts) {
    const at = contracts.findIndex((x) => x.name === c.name);
    if (at >= 0) contracts[at] = c;
    else contracts.push(c);
  }

  return { snapshots: { ...prev.snapshots, [agent]: w.snapshot }, decisions, contracts };
}

/**
 * `forAgent`'ın görmesi gereken kararlar — model çağrısı yok, deterministik.
 * Kendi kararları + onu etkileyenler + genel kararlar (`affects` boş).
 * Başka agent'ları etkileyen kararlar elenir. Sıra sicildeki sırayla aynı.
 */
export function relevantDecisions(decisions: readonly DecisionRecord[], forAgent: string): DecisionRecord[] {
  return decisions.filter((d) => d.owner === forAgent || d.affects.length === 0 || d.affects.includes(forAgent));
}

/**
 * Sıkıştırma eşiği. Değerler eski tasarımın tavanları: agent başına 10 karar ×
 * iki agent ve oda başına 10 sözleşme. Yani olay "eski tasarım burada bilgi
 * atmaya başlardı" anlamına geliyor; Hafta 11'de bunun ne sıklıkla ve hangi
 * büyüklükte olduğu ölçülmüş olacak.
 */
export const JOURNAL_COMPACTION_THRESHOLD = { relevantDecisions: 20, contracts: 10 } as const;

export type JournalCompaction = {
  agent: string;
  relevantDecisions: number;
  totalDecisions: number;
  contracts: number;
  needed: boolean;
};

/** `journal.compaction_needed` event'inin ölçümü; `needed` false ise yazılmaz. */
export function journalCompaction(state: JournalState, forAgent: string): JournalCompaction {
  const relevant = relevantDecisions(state.decisions, forAgent).length;
  return {
    agent: forAgent,
    relevantDecisions: relevant,
    totalDecisions: state.decisions.length,
    contracts: state.contracts.length,
    needed:
      relevant > JOURNAL_COMPACTION_THRESHOLD.relevantDecisions ||
      state.contracts.length > JOURNAL_COMPACTION_THRESHOLD.contracts,
  };
}
