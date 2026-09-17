import { z } from "zod";
import { AgentName } from "./ids.js";

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
    toolsAllow: z.array(z.string().min(1)).default(["bash", "edit", "read", "test"]),
    toolsDeny: z.array(z.string().min(1)).default([]),
    /** rw mount'lar. Bu listenin dışı container içinde read-only bağlanır. */
    writable: z.array(z.string().min(1)).default([]),
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
    agents: z.array(AgentConfig).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const [i, a] of cfg.agents.entries()) {
      if (seen.has(a.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", i, "name"],
          message: `agent adı tekrar ediyor: ${a.name}`,
        });
      }
      seen.add(a.name);

      // Bir agent kendi workspace'i dışına yazamamalı; contracts ve journal istisna.
      const allowedRoots = [a.workspace, cfg.contractsDir, cfg.journalDir];
      for (const [j, w] of a.writable.entries()) {
        if (!allowedRoots.some((root) => w === root || w.startsWith(`${root}/`))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["agents", i, "writable", j],
            message: `"${w}" bu agent'ın workspace'i, contracts veya journal altında değil`,
          });
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
