import { z } from "zod";
import { AgentName } from "./ids.js";
import { isInside } from "./paths.js";
import { RuntimeKind } from "./runtime.js";
import { ToolName } from "./tools.js";

/**
 * Rol konfigürasyonu.
 *
 * Kural: agent sayısı hiçbir yerde sabit değil. Kod her yerde bu diziyi dolaşır,
 * UI `agents.map()` yapar, defter referansları isimle verilir.
 * 3. agent eklemek tek bir YAML bloğu olmalı.
 */

export const ApprovalKind = z.enum([
  "git_push",
  "migration",
  "dep_add",
  "network",
  "secret_read",
  "other",
]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const AgentConfig = z
  .object({
    name: AgentName,
    /** Rolün sistem prompt'u. Kısıtlar buraya YAZILMAZ — dosya izniyle uygulanır. */
    systemPrompt: z.string().min(1),
    /** Oda köküne göre çalışma alanı: worktrees/frontend */
    workspace: z.string().min(1),
    model: z.string().min(1).default("claude-sonnet-5"),
    /** Hangi koşum ortamı container içinde koşacak. Sözleşme: runtime.ts */
    runtime: RuntimeKind.default("claude"),
    // Serbest string değil sabit küme: YAML'da yanlış yazılmış bir tool adı
    // sessizce yutulmak yerine config yüklenirken hata verir.
    toolsAllow: z.array(ToolName).default(["bash", "edit", "read"]),
    toolsDeny: z.array(ToolName).default([]),
    /**
     * Yazma yetkisi. Hafta 7'den beri yalnızca iki şey olabilir: agent'ın KENDİ
     * worktree'si ve `contracts`. Uygulaması mount değil, Unix izinleri
     * (`packages/core/src/room-fs.ts`).
     */
    writable: z.array(z.string().min(1)).default([]),
    /**
     * Okuma yetkisi — başka agent'ların worktree'leri. Varsayılan BOŞ: bir
     * agent diğerinin klasörünü göremez bile (dizin 0750).
     * "worktrees/<ad>" ya da hepsi için "worktrees/*".
     */
    readable: z.array(z.string().min(1)).default([]),
    approvalRequired: z.array(ApprovalKind).default(["git_push", "migration"]),
    /** Sürekli koşmaz, event ile uyanır (planner gibi roller için). */
    eventDriven: z.boolean().default(false),
  })
  .strict();
export type AgentConfig = z.infer<typeof AgentConfig>;

export const RoomBudget = z
  .object({
    /** Bütçe dolunca oda temiz durur ve sorar — hard stop. */
    maxUsd: z.number().positive().default(25),
    maxTurns: z.number().int().positive().default(2000),
  })
  .strict();
export type RoomBudget = z.infer<typeof RoomBudget>;

/**
 * Oda başına redaction ayarı.
 *
 * `allow_patterns`: projede TEKRAR EDEN yanlış pozitifler için. Örneğin bir
 * test fixture'ı gerçek anahtar formatında sahte bir değer taşıyorsa her
 * turn'de maskelenip çıktıyı okunmaz hale getirir. Desenler entropi
 * taramasına uygulanır; kural setini SUSTURMAZ (bilinen formatlı bir secret
 * her zaman maskelenir).
 */
export const RedactionConfig = z
  .object({
    allow_patterns: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type RedactionConfig = z.infer<typeof RedactionConfig>;

/**
 * Merkez deponun kaynağı.
 *
 * `local` bilinçli olarak kısıtlı: sunucu makinesindeki KEYFİ bir yol
 * klonlanamaz, yalnızca `ROOMS_SOURCE_ROOT` altındakiler. Değişken tanımlı
 * değilse `local` tamamen reddedilir — "açıkça izin verilmediyse hayır".
 */
export const RepoSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }).strict(),
  z.object({ kind: z.literal("local"), path: z.string().min(1), ref: z.string().min(1).default("HEAD") }).strict(),
  z.object({ kind: z.literal("git"), url: z.string().url(), ref: z.string().min(1).default("HEAD") }).strict(),
]);
export type RepoSource = z.infer<typeof RepoSource>;

/**
 * `local` kaynağın altında kalmak zorunda olduğu kök. Şema doğrulanırken
 * okunur; test edilebilmesi için ortam değişkenine doğrudan değil bu
 * fonksiyona bakılır.
 */
export function sourceRoot(): string {
  return (typeof process !== "undefined" && process.env?.ROOMS_SOURCE_ROOT) || "";
}

export const RoomConfig = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(120),
    repoUrl: z.string().url().nullable().default(null),
    baseBranch: z.string().min(1).default("main"),
    /** Herkese yazılabilir tek ortak alan — koordinasyon buradan geçer. */
    contractsDir: z.string().min(1).default("contracts"),
    journalDir: z.string().min(1).default("journal"),
    budget: RoomBudget.default({ maxUsd: 25, maxTurns: 2000 }),
    redaction: RedactionConfig.default({ allow_patterns: [] }),
    /**
     * Odanın merkez deposu neyden kurulacak. Merkez depo `rooms-integrator`
     * kullanıcısına ait ve agent'lar için salt okunurdur; her agent ondan
     * `git clone --shared` ile kendi deposunu alır (Hafta 7, Karar 3).
     */
    repo: RepoSource.default({ kind: "empty" }),
    agents: z.array(AgentConfig).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const names = new Set(cfg.agents.map((a) => a.name));
    const seen = new Set<string>();

    // --- oda düzeyi: contracts worktree'lerin altında olamaz -----------------
    // Olursa "ortak yazılabilir alan" bir agent'ın özel alanının içine düşer ve
    // izin planı kendi kendisiyle çelişir.
    if (cfg.contractsDir === "worktrees" || cfg.contractsDir.startsWith("worktrees/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contractsDir"],
        message: `contracts klasörü worktrees altında olamaz: "${cfg.contractsDir}"`,
      });
    }

    // --- repo kaynağı --------------------------------------------------------
    if (cfg.repo.kind === "local") {
      const root = sourceRoot();
      if (!root) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repo", "path"],
          message:
            "yerel kaynak reddedildi: sunucuda ROOMS_SOURCE_ROOT tanımlı değil. " +
            "Klonlanabilecek yolların kökünü açıkça belirtmeden yerel depo kullanılamaz.",
        });
      } else if (!isInside(root, cfg.repo.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repo", "path"],
          message: `yerel kaynak ROOMS_SOURCE_ROOT ("${root}") altında değil: "${cfg.repo.path}"`,
        });
      }
    }

    for (const [i, a] of cfg.agents.entries()) {
      if (seen.has(a.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", i, "name"],
          message: `agent adı tekrar ediyor: ${a.name}`,
        });
      }
      seen.add(a.name);

      const own = `worktrees/${a.name}`;

      // --- workspace tam olarak worktrees/<ad> --------------------------------
      // Serbest bırakılırsa izin planı ile config birbirinden kayar: plan
      // klasörü adından türetiyor, runner config'ten okuyor.
      if (a.workspace !== own) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", i, "workspace"],
          message: `workspace tam olarak "${own}" olmalı, "${a.workspace}" değil`,
        });
      }

      // --- writable: yalnızca kendi worktree'si ve contracts ------------------
      for (const [j, w] of a.writable.entries()) {
        const isOwn = w === own || w.startsWith(`${own}/`);
        const isContracts = w === cfg.contractsDir || w.startsWith(`${cfg.contractsDir}/`);
        if (isOwn || isContracts) continue;

        // Başka bir worktree'ye yazma isteği en sık yapılacak hata; mesajı kuralı
        // anlatsın, yalnızca "geçersiz" demesin.
        if (w === "worktrees" || w.startsWith("worktrees/")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["agents", i, "writable", j],
            message: `\`${a.name}\`, \`${w}\`'e yazma yetkisi alamaz: her worktree'nin tek yazarı sahibidir.`,
          });
        } else {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["agents", i, "writable", j],
            message: `"${w}" yazılabilir olamaz: yalnızca "${own}" ve "${cfg.contractsDir}" verilebilir`,
          });
        }
      }

      // --- readable: yalnızca BAŞKA worktree'ler ------------------------------
      for (const [j, r] of a.readable.entries()) {
        if (r === "worktrees/*") continue;
        const issue = (message: string) =>
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", i, "readable", j], message });

        if (!r.startsWith("worktrees/")) {
          issue(`"${r}" okunabilir olamaz: yalnızca "worktrees/<agent>" veya "worktrees/*" verilebilir`);
          continue;
        }
        const target = r.slice("worktrees/".length);
        if (target.includes("/")) {
          issue(`"${r}" okuma yetkisi worktree'nin tamamına verilir, alt klasöre değil`);
          continue;
        }
        if (target === a.name) {
          issue(`"${r}" zaten ${a.name}'in kendi worktree'si; readable'da yer almaz`);
          continue;
        }
        if (!names.has(target)) {
          issue(`"${r}" okunamaz: "${target}" adında bir agent yok`);
        }
      }
    }
  });

export type RoomConfig = z.infer<typeof RoomConfig>;

/** Oda kökündeki klasör düzeni — worktree'ler, sözleşmeler, defter. */
export function roomLayout(cfg: RoomConfig): string[] {
  return [
    ...cfg.agents.map((a) => a.workspace),
    cfg.contractsDir,
    cfg.journalDir,
  ];
}

/** Branch adlandırma: room-42/frontend */
export function branchName(roomShortId: string, agent: string): string {
  return `room-${roomShortId}/${agent}`;
}
