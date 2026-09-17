import { z } from "zod";
import { Actor, AgentName, ApprovalId, RoomId, SessionId, TaskId } from "./ids.js";

/**
 * Event kataloğu — v1.
 *
 * Tek kural: her şey append-only log'a yazılır, UI bunun projeksiyonudur.
 * Bir durum bu listede yoksa UI'da da yoktur. Yeni bir durum eklemenin yolu
 * yeni bir event tipi eklemektir, mevcut bir kaydı değiştirmek değil.
 *
 * `output.chunk` tek istisnadır: sunum düzlemi için ham PTY byte'ı taşır.
 * Kontrol düzlemi ondan asla okumaz — kontrol `tool.*` ve `file.*`'dan gelir.
 */

/** Ortak zarf. Her event'te aynı. */
export const EventEnvelope = z.object({
  /** Oturum içinde 1'den başlayan kesintisiz sıra. (session_id, seq) unique. */
  seq: z.number().int().positive(),
  roomId: RoomId,
  sessionId: SessionId,
  /** Sunucu saati, ISO 8601. */
  ts: z.string().datetime(),
  actor: Actor,
});

const ev = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  EventEnvelope.extend({ type: z.literal(type), payload });

// --- Oda ve oturum yaşam döngüsü -------------------------------------------

export const RoomCreated = ev(
  "room.created",
  z.object({
    name: z.string().min(1).max(120),
    repoUrl: z.string().url().nullable(),
    /** Rol YAML'ının sha256'sı — oda hangi konfigürasyonla açıldı. */
    configDigest: z.string().min(1),
  }),
);

export const SessionStarted = ev(
  "session.started",
  z.object({
    containerId: z.string().min(1),
    /** Rol YAML'ında tanımlı agent adları. Sayı sabit değil — dizi. */
    agents: z.array(AgentName).min(1),
  }),
);

export const SessionEnded = ev(
  "session.ended",
  z.object({
    reason: z.enum(["user_stopped", "crashed", "budget_exhausted", "idle_timeout"]),
    detail: z.string().max(2000).nullable(),
  }),
);

// --- Agent süreç yaşam döngüsü ---------------------------------------------

export const AgentSpawned = ev(
  "agent.spawned",
  z.object({
    agent: AgentName,
    workspace: z.string().min(1),
    model: z.string().min(1),
    pid: z.number().int().positive().nullable(),
  }),
);

export const AgentExited = ev(
  "agent.exited",
  z.object({
    agent: AgentName,
    code: z.number().int().nullable(),
    reason: z.enum(["completed", "killed", "crashed"]),
  }),
);

// --- Yönerge ve turn -------------------------------------------------------

export const AgentMessage = ev(
  "agent.message",
  z.object({
    agent: AgentName,
    text: z.string().min(1),
    /** Kuyruktaki sırası — aynı agent'a iki mesaj asla paralel inference'a girmez. */
    queuePosition: z.number().int().nonnegative(),
  }),
);

export const AgentInterrupted = ev(
  "agent.interrupted",
  z.object({
    agent: AgentName,
    /** Uzun bash komutu ortasında anlık kesilemez; kuyruğa alındıysa false. */
    applied: z.boolean(),
  }),
);

export const TurnStarted = ev(
  "turn.started",
  z.object({ agent: AgentName, turn: z.number().int().positive() }),
);

export const TurnEnded = ev(
  "turn.ended",
  z.object({
    agent: AgentName,
    turn: z.number().int().positive(),
    stopReason: z.enum(["end_turn", "max_tokens", "interrupted", "error"]),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheReadTokens: z.number().int().nonnegative().default(0),
        costUsd: z.number().nonnegative().default(0),
      })
      .nullable(),
  }),
);

// --- Tool çağrıları: kontrol düzleminin tek kaynağı -------------------------

export const ToolCalled = ev(
  "tool.called",
  z.object({
    agent: AgentName,
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
    /** Tool-öncesi hook'un risk sınıfı. `risky` olanlar onay kuyruğuna düşer. */
    risk: z.enum(["safe", "risky"]).default("safe"),
  }),
);

export const ToolResult = ev(
  "tool.result",
  z.object({
    agent: AgentName,
    toolUseId: z.string().min(1),
    isError: z.boolean(),
    /** Redaction'dan GEÇMİŞ çıktı. Ham hali hiçbir zaman DB'ye yazılmaz. */
    output: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
);

// --- Dosya ve diff ---------------------------------------------------------

export const FileChanged = ev(
  "file.changed",
  z.object({
    agent: AgentName,
    path: z.string().min(1),
    change: z.enum(["created", "modified", "deleted", "renamed"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
);

export const DiffUpdated = ev(
  "diff.updated",
  z.object({
    agent: AgentName,
    /** worktree HEAD'ine göre unified diff'in sha256'sı — istemci değişti mi diye bakar. */
    digest: z.string().min(1),
    files: z.array(z.string().min(1)),
  }),
);

// --- Oda defteri -----------------------------------------------------------

export const JournalUpdated = ev(
  "journal.updated",
  z.object({
    agent: AgentName,
    entryId: z.string().min(1),
    version: z.number().int().positive(),
    /** Bu kayıt hangi eski kaydın yerine geçti — özet kaymasına karşı. */
    supersedes: z.string().nullable(),
  }),
);

// --- Görev panosu ----------------------------------------------------------

export const TaskCreated = ev(
  "task.created",
  z.object({
    taskId: TaskId,
    title: z.string().min(1).max(200),
    assignee: AgentName.nullable(),
    dependsOn: z.array(TaskId).default([]),
  }),
);

export const TaskUpdated = ev(
  "task.updated",
  z.object({
    taskId: TaskId,
    status: z.enum(["open", "claimed", "in_progress", "blocked", "done", "cancelled"]),
    /** done'a geçiş için zorunlu: test çıktısı, diff sha veya commit. */
    evidence: z.string().min(1).nullable(),
  }),
);

// --- Onay kuyruğu ----------------------------------------------------------

export const ApprovalRequested = ev(
  "approval.requested",
  z.object({
    approvalId: ApprovalId,
    agent: AgentName,
    toolUseId: z.string().min(1),
    kind: z.enum(["git_push", "migration", "dep_add", "network", "secret_read", "other"]),
    preview: z.string().max(4000),
  }),
);

export const ApprovalResolved = ev(
  "approval.resolved",
  z.object({
    approvalId: ApprovalId,
    decision: z.enum(["approved", "rejected", "timed_out"]),
  }),
);

// --- İnsan katmanı: yorum, presence, sürücü --------------------------------

export const CommentOnLine = ev(
  "comment.on_line",
  z.object({
    agent: AgentName,
    path: z.string().min(1),
    line: z.number().int().positive(),
    text: z.string().min(1).max(4000),
    /** Agent'ın bir sonraki turn'üne yönerge olarak enjekte edildi mi? */
    injected: z.boolean().default(false),
  }),
);

export const PresenceUpdated = ev(
  "presence.updated",
  z.object({
    /** Kullanıcı hangi agent'a bakıyor — null ise oda görünümünde. */
    watching: AgentName.nullable(),
    state: z.enum(["joined", "moved", "left"]),
  }),
);

export const DriverChanged = ev(
  "driver.changed",
  z.object({
    agent: AgentName,
    /** Sürücü devri: null = sürücü boşaldı. */
    driverId: z.string().min(1).nullable(),
  }),
);

// --- Sunum düzlemi (kontrol buradan OKUMAZ) --------------------------------

export const OutputChunk = ev(
  "output.chunk",
  z.object({
    agent: AgentName,
    /** 50-100ms batch'lenmiş ANSI byte'ları, redaction'dan geçmiş. */
    data: z.string(),
    stream: z.enum(["stdout", "stderr"]).default("stdout"),
  }),
);

// --- Union -----------------------------------------------------------------

const EVENT_SCHEMAS = [
  RoomCreated,
  SessionStarted,
  SessionEnded,
  AgentSpawned,
  AgentExited,
  AgentMessage,
  AgentInterrupted,
  TurnStarted,
  TurnEnded,
  ToolCalled,
  ToolResult,
  FileChanged,
  DiffUpdated,
  JournalUpdated,
  TaskCreated,
  TaskUpdated,
  ApprovalRequested,
  ApprovalResolved,
  CommentOnLine,
  PresenceUpdated,
  DriverChanged,
  OutputChunk,
] as const;

export const RoomEvent = z.discriminatedUnion("type", [...EVENT_SCHEMAS]);
export type RoomEvent = z.infer<typeof RoomEvent>;
export type RoomEventType = RoomEvent["type"];

/** Log'a yazmadan önceki hali — `seq` ve `ts` sunucu tarafında atanır. */
export const NewRoomEvent = z.discriminatedUnion("type", [
  ...(EVENT_SCHEMAS.map((s) => s.omit({ seq: true, ts: true })) as unknown as [
    (typeof EVENT_SCHEMAS)[number],
    (typeof EVENT_SCHEMAS)[number],
    ...(typeof EVENT_SCHEMAS)[number][],
  ]),
]);
export type NewRoomEvent = Omit<RoomEvent, "seq" | "ts">;

export const ALL_EVENT_TYPES = EVENT_SCHEMAS.map((s) => s.shape.type.value) as RoomEventType[];

/** Sunum düzlemine ait, kontrol kararlarında kullanılması yasak event'ler. */
export const PRESENTATION_ONLY: ReadonlySet<RoomEventType> = new Set<RoomEventType>([
  "output.chunk",
]);

export function parseEvent(input: unknown): RoomEvent {
  return RoomEvent.parse(input);
}
