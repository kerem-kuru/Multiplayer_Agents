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

/** Agent'a ait her event'te zorunlu. */
const AgentRef = { agent: AgentName };
/** Bir turn'ün içindeki her event'te zorunlu — hangi mesaja ait olduğu belli olsun. */
const TurnRef = { agent: AgentName, messageId: z.string().uuid() };

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

// --- Agent süreç yaşam döngüsü (actor: system) ------------------------------
//
// Bu event'ler agent'ın ne DEDİĞİNİ değil, runner sürecinin ne DURUMDA
// olduğunu anlatır. Durum makinesi `agent_runtime` tablosunda.

export const AgentStarting = ev(
  "agent.starting",
  z.object({
    ...AgentRef,
    /** Önceki SDK oturumu varsa sohbet oradan devam eder. */
    resumeSessionId: z.string().nullable(),
  }),
);

export const AgentReady = ev(
  "agent.ready",
  z.object({ ...AgentRef, runnerPid: z.number().int() }),
);

export const AgentExited = ev(
  "agent.exited",
  z.object({
    ...AgentRef,
    exitCode: z.number().int().nullable(),
    /** Beklenen çıkış. Beklenmeyen çıkış `agent.crashed`. */
    reason: z.enum(["stopped", "server_restart"]),
  }),
);

export const AgentCrashed = ev(
  "agent.crashed",
  z.object({
    ...AgentRef,
    exitCode: z.number().int().nullable(),
    error: z.string(),
    willRestart: z.boolean(),
    restartCount: z.number().int().nonnegative(),
  }),
);

// --- Yönerge ve turn -------------------------------------------------------

/** actor = isteği yapan insan. Turn'ün başlangıç noktası. */
export const MessageReceived = ev(
  "message.received",
  z.object({ ...TurnRef, text: z.string().min(1) }),
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
  z.object({
    ...TurnRef,
    sdkSessionId: z.string(),
    model: z.string(),
    /** SDK'nın init mesajından okunan GERÇEK tool listesi — YAML'ın iddiası değil. */
    tools: z.array(z.string()),
  }),
);

/** Agent'ın ürettiği düz metin. Kontrol düzlemi bundan ASLA anlam çıkarmaz. */
export const AgentText = ev("agent.text", z.object({ ...TurnRef, text: z.string() }));

export const TurnCompleted = ev(
  "turn.completed",
  z.object({
    ...TurnRef,
    subtype: z.string(),
    numTurns: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
    usage: z.record(z.unknown()),
  }),
);

export const TurnFailed = ev(
  "turn.failed",
  z.object({
    ...TurnRef,
    reason: z.enum(["aborted", "crash", "sdk_error", "stopped"]),
    error: z.string(),
  }),
);

// --- Tool çağrıları: kontrol düzleminin tek kaynağı -------------------------

export const ToolCall = ev(
  "tool.call",
  z.object({
    ...TurnRef,
    toolUseId: z.string().min(1),
    tool: z.string().min(1),
    /** 16 KB'ı aşarsa kırpılır; `truncated` bunu söyler. */
    input: z.unknown(),
    truncated: z.boolean(),
  }),
);

export const ToolResult = ev(
  "tool.result",
  z.object({
    ...TurnRef,
    toolUseId: z.string().min(1),
    isError: z.boolean(),
    /** Hafta 4'ten itibaren redaction'dan geçmiş olacak. */
    output: z.string(),
    truncated: z.boolean(),
  }),
);

/** PreToolUse hook'u YAML'a aykırı bir çağrıyı reddetti. Yetki kanıtı burada. */
export const ToolDenied = ev(
  "tool.denied",
  z.object({ ...TurnRef, tool: z.string().min(1), reason: z.string() }),
);

// --- Dosya ve diff ---------------------------------------------------------

/** Hafta 6'ya kadar sadece yol + tool. Diff üretimi orada gelecek. */
export const FileChanged = ev(
  "file.changed",
  z.object({ ...TurnRef, path: z.string().min(1), tool: z.string().min(1) }),
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

// --- Geliştirme ------------------------------------------------------------

export const DebugNote = ev(
  "debug.note",
  z.object({
    /** Elle yazılan not. Hafta 1'de "event yazıp since=N ile geri oku" kapısı bunu kullanır. */
    text: z.string().min(1).max(4000),
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
  AgentStarting,
  AgentReady,
  AgentExited,
  AgentCrashed,
  MessageReceived,
  AgentInterrupted,
  TurnStarted,
  AgentText,
  TurnCompleted,
  TurnFailed,
  ToolCall,
  ToolResult,
  ToolDenied,
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
  DebugNote,
  OutputChunk,
] as const;

export const RoomEvent = z.discriminatedUnion("type", [...EVENT_SCHEMAS]);
export type RoomEvent = z.infer<typeof RoomEvent>;
export type RoomEventType = RoomEvent["type"];

/**
 * Log'a yazmadan önceki hali — `seq` ve `ts` sunucu tarafında atanır.
 *
 * DİKKAT: aşağıdaki cast yüzünden bu sabitin ÇIKARSANAN tipi yanlış (`seq`/`ts`
 * içeriyor). Çalışma zamanı doğrulaması doğru. Tip için daima aşağıdaki
 * `NewRoomEvent` takma adını kullan, `z.infer<typeof NewRoomEvent>` değil.
 */
export const NewRoomEvent = z.discriminatedUnion("type", [
  ...(EVENT_SCHEMAS.map((s) => s.omit({ seq: true, ts: true })) as unknown as [
    (typeof EVENT_SCHEMAS)[number],
    (typeof EVENT_SCHEMAS)[number],
    ...(typeof EVENT_SCHEMAS)[number][],
  ]),
]);
/**
 * Düz `Omit<RoomEvent, ...>` KULLANILMAZ: Omit birleşimi dağıtmaz, hepsini tek
 * bir nesne tipine çökertir ve `type` üzerinden daraltma çalışmaz olur —
 * `e.type === "tool.call" && e.payload.tool` derlenmez. Dağıtımlı hâli birleşimi
 * korur.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewRoomEvent = DistributiveOmit<RoomEvent, "seq" | "ts">;

export const ALL_EVENT_TYPES = EVENT_SCHEMAS.map((s) => s.shape.type.value) as RoomEventType[];

/** Sunum düzlemine ait, kontrol kararlarında kullanılması yasak event'ler. */
export const PRESENTATION_ONLY: ReadonlySet<RoomEventType> = new Set<RoomEventType>([
  "output.chunk",
]);

export function parseEvent(input: unknown): RoomEvent {
  return RoomEvent.parse(input);
}
