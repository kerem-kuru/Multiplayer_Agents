import { z } from "zod";
import { CheckpointId, CheckpointKind, CommentSide, FileDiff } from "./diff.js";
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

/**
 * Bir insan. Hafta 5'te kuyruk, sürücü ve kesme event'leri KİMİN yaptığını
 * payload'da da taşır: `actor` zarfta duruyor ama projeksiyon zarfa değil
 * payload'a bakarak isim gösterebilsin ve snapshot'lar kendi kendine yeter
 * olsun.
 */
const UserRef = z.object({ id: z.string().uuid(), name: z.string().min(1).max(120) });

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

/**
 * Mesaj KUYRUĞA girdi. `actor` = yazan insan.
 *
 * Sıra sözleşmesi:
 *   message.queued → (kuyruktan çıkınca) message.received → turn.started → …
 *                  → turn.completed / turn.failed
 *   kuyrukta iptal edilirse: message.queued → message.cancelled
 *   (o mesaj `message.received` HİÇ almaz)
 *
 * `text` kullanıcının yazdığı HAM metindir: `[Ayse]: ` öneki event log'da
 * DEĞİL, mesaj kuyruktan çıkıp runner'a verilirken eklenir.
 */
export const MessageQueued = ev(
  "message.queued",
  z.object({
    ...TurnRef,
    text: z.string().min(1),
    user: UserRef,
    /**
     * Bu kayıt bir İNCELEMEden geldiyse (Hafta 6) onun kimliği. UI kuyruk
     * satırını "Ayşe'nin 3 yorumluk incelemesi" diye gösterebilsin ve
     * yorumlara gidebilsin diye. Düz mesajlarda yok.
     */
    reviewId: z.string().uuid().optional(),
  }),
);

/**
 * Kuyruk kaydı iptal edildi — o mesaj HİÇ çalışmadı.
 *
 * `server_restart`: sunucu koşarken düştü, mesaj yeniden KOŞTURULMAZ (Hafta
 * 2'den gelen kural: agent yarısını yapmış olabilir).
 * `agent_failed`: agent kurtarılamadı; sessizce bekleyen bir kuyruk
 * kullanıcıya yalan söyler.
 */
export const MessageCancelled = ev(
  "message.cancelled",
  z.object({
    ...TurnRef,
    /**
     * İptal eden insan. `server_restart` ve `agent_failed` sebeplerinde
     * NULL: o iptali bir insan yapmadı ve kaydın sahibini "iptal eden" diye
     * yazmak log'u yalancı yapardı.
     */
    by: UserRef.nullable(),
    reason: z.enum(["user", "driver", "server_restart", "agent_failed"]),
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
    /** `interrupted`: sürücü kesti (Hafta 5). Kesilen mesaj tekrar koşmaz. */
    reason: z.enum(["aborted", "crash", "sdk_error", "stopped", "interrupted"]),
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

/**
 * Yol + tool. Hafta 6'da diff geldi ama bu event KALDI: etkinlik akışı tool
 * satırının altında "hangi dosyalara dokundu" bilgisini buradan alıyor ve
 * diff'ten okunamaz — diff "neye göre" sorusunun cevabı, "hangi çağrı"
 * sorusunun değil.
 */
export const FileChanged = ev(
  "file.changed",
  z.object({ ...TurnRef, path: z.string().min(1), tool: z.string().min(1) }),
);

/**
 * Checkpoint alındı.
 *
 * `becomesBase`: baseline ve manuel checkpoint'ler yeni taban olur (diff
 * sıfırlanır), turn checkpoint'i OLMAZ — her turn sonunda tabanı kaydırmak
 * "bu oturumda ne değişti" sorusunu cevapsız bırakırdı.
 */
/**
 * Odanın merkez deposu kuruldu.
 *
 * Merkez depo `rooms-integrator` kullanıcısına aittir ve agent'lar için salt
 * okunurdur. Her agent ondan `git clone --shared` ile kendi deposunu alır —
 * `git worktree` DEĞİL (Hafta 7, Karar 3): worktree'de tüm çalışma ağaçları
 * tek bir `.git` paylaşır ve bir agent diğerinin branch'ini silebilir ya da
 * ortak config'e hook ekleyip diğerinin git komutlarında kod çalıştırabilirdi.
 */
export const RoomRepoInitialized = ev(
  "room.repo_initialized",
  z.object({
    source: z.enum(["empty", "local", "git"]),
    baseRef: z.string().min(1),
    baseSha: z.string().min(1),
  }),
);

/** Agent'ın kendi deposu klonlandı ve branch'i açıldı. */
export const AgentWorkspaceReady = ev(
  "agent.workspace_ready",
  z.object({
    ...AgentRef,
    branch: z.string().min(1),
    baseSha: z.string().min(1),
  }),
);

export const CheckpointCreated = ev(
  "checkpoint.created",
  z.object({
    ...AgentRef,
    checkpointId: CheckpointId,
    kind: CheckpointKind,
    label: z.string().min(1).max(200),
    commitSha: z.string().min(1),
    treeSha: z.string().min(1),
    /** Turn checkpoint'inde dolu: hangi mesajdan sonra alındı. */
    messageId: z.string().uuid().nullable(),
    /** Manuel checkpoint'te dolu: kim aldı. */
    by: UserRef.nullable(),
    becomesBase: z.boolean(),
  }),
);

/**
 * Diff değişti — SADECE DEĞİŞEN DOSYALAR.
 *
 * Her araç çağrısından sonra tüm diff yeniden yazılsaydı log şişerdi ve
 * ikinci kullanıcının ekranı her seferinde baştan çizilirdi. Runner son
 * yayımlanan `path → parmak izi` haritasını tutuyor; yalnızca değişen, yeni
 * eklenen veya tabana geri dönen (`status: "clean"`) dosyalar gidiyor.
 *
 * Patch metinleri `appendEvent`'ten geçtiği için içlerindeki secret'lar
 * MASKELENİR. Maske satır içinde yapılır, satır sonu eklenmez — diff'in satır
 * yapısı bozulmaz.
 */
export const DiffUpdated = ev(
  "diff.updated",
  z.object({
    ...AgentRef,
    /** Turn içinde üretildiyse hangi mesajın turn'ünde. Turn dışıysa null. */
    messageId: z.string().uuid().nullable(),
    baseCheckpointId: CheckpointId,
    files: z.array(FileDiff).min(1),
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

// --- Yetki isteği ----------------------------------------------------------

/**
 * İzleyici "beni katılımcı yap" diyor.
 *
 * Neden event: rol değişikliğinin GEREKÇESİ de odanın tarihine giriyor. Ayrı
 * bir tabloda tutulsaydı "bu kişi neden katılımcı oldu" sorusunun cevabı event
 * log'da olmazdı ve ikinci bir gerçek kaynak doğardı.
 *
 * İstenen rol yalnızca `member`: `owner` istemek bir yetki devri, istek değil.
 */
export const AccessRequested = ev(
  "access.requested",
  z.object({
    requestId: z.string().uuid(),
    user: UserRef,
    role: z.literal("member"),
    /** İsteğe bağlı tek satır: "diff'e yorum bırakacağım". */
    note: z.string().max(280).nullable(),
  }),
);

/**
 * Sahip karar verdi. `granted` ise rol DEĞİŞTİRİLDİKTEN sonra yazılır: event
 * "oldu" demek, "olacak" demek değil.
 */
export const AccessResolved = ev(
  "access.resolved",
  z.object({
    requestId: z.string().uuid(),
    decision: z.enum(["granted", "denied"]),
    /** İsteği yapan — istemci karar satırını kime ait göstereceğini bilsin. */
    user: UserRef,
    by: UserRef,
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

/**
 * Bir satıra bırakılmış yorum.
 *
 * ÇAPA SATIR NUMARASI + SATIRIN METNİDİR. Satır numarası tek başına kayar:
 * agent araya üç satır eklerse 42 artık başka bir satırdır. `lineText`
 * yorumun sessizce yanlış satıra kaymasını engeller — kayma olduğunda yorum
 * "eskimiş" işaretlenir.
 *
 * `diffSeq`: yorumcunun GÖRDÜĞÜ `diff.updated` event'inin seq'i. Sunucu
 * çapayı bu ana göre doğruluyor.
 */
export const CommentOnLine = ev(
  "comment.on_line",
  z.object({
    ...AgentRef,
    commentId: z.string().uuid(),
    reviewId: z.string().uuid(),
    author: UserRef,
    path: z.string().min(1),
    side: CommentSide,
    line: z.number().int().positive(),
    /** Yorumcunun gördüğü satır, OLDUĞU GİBİ. Kırpılmaz, normalize edilmez. */
    lineText: z.string(),
    body: z.string().min(1).max(4000),
    baseCheckpointId: CheckpointId,
    diffSeq: z.number().int(),
  }),
);

/**
 * Bir inceleme gönderildi: aynı kişinin aynı oturumdaki N yorumu TEK turn.
 *
 * Hafta 5'teki "mesajlar birleştirilmez" kuralı bozulmuyor — birleştirilen
 * şey aynı kişinin aynı inceleme içindeki yorumları. Farklı kişilerin
 * incelemeleri yine ayrı turn'ler. Beş satıra yorum yazan biri beş turn
 * beklemez; tek bir inceleme gönderir.
 */
export const ReviewSubmitted = ev(
  "review.submitted",
  z.object({
    ...AgentRef,
    reviewId: z.string().uuid(),
    author: UserRef,
    commentIds: z.array(z.string().uuid()).min(1),
    /** Kuyruğa giren mesaj. Metni SUNUCU kuruyor, istemci hazır prompt yollamıyor. */
    messageId: z.string().uuid(),
  }),
);

/**
 * Yorumun durumu İNSAN KARARIDIR. Agent cevabında "uyguladım" diyebilir ama
 * yorumu kapatamaz: kapatma düğmesi insanda.
 */
export const CommentResolved = ev(
  "comment.resolved",
  z.object({ ...AgentRef, commentId: z.string().uuid(), by: UserRef }),
);

export const CommentReopened = ev(
  "comment.reopened",
  z.object({ ...AgentRef, commentId: z.string().uuid(), by: UserRef }),
);

export const PresenceUpdated = ev(
  "presence.updated",
  z.object({
    /** Kullanıcı hangi agent'a bakıyor — null ise oda görünümünde. */
    watching: AgentName.nullable(),
    state: z.enum(["joined", "moved", "left"]),
  }),
);

/**
 * Sürücülük — agent başına bir rol, bir kilit DEĞİL.
 *
 * Sürücü olmayan odayı kullanmaya devam eder: mesaj yazar, kuyruğa girer.
 * Sürücünün fazladan iki yetkisi var: koşan turn'ü kesmek ve başkasının
 * kuyruk kaydını iptal etmek.
 *
 * Hafta 1'deki tek `driver.changed` event'i yerine üç ayrı event: "kim aldı",
 * "kim bıraktı, neden" ve "kimden kime" farklı sorulardır ve devir
 * tarihçesinde ikisini ayırt etmek gerekir.
 */
export const DriverClaimed = ev("driver.claimed", z.object({ ...AgentRef, user: UserRef }));

export const DriverReleased = ev(
  "driver.released",
  z.object({
    ...AgentRef,
    user: UserRef,
    /** `left_room`: presence 60 sn kayıptı — sürücülük kendiliğinden düştü. */
    reason: z.enum(["manual", "left_room", "handoff"]),
  }),
);

export const DriverHandedOff = ev(
  "driver.handed_off",
  z.object({ ...AgentRef, from: UserRef, to: UserRef }),
);

/**
 * KESME İKİ EVENT'TİR ve arasındaki süre sıfır değildir.
 *
 * `interrupt.requested` istek anında yazılır; `interrupt.applied` gerçekten
 * durduğunda. Uzun bir bash komutunun ortasında anlık durdurma sözü
 * verilmiyor — UI aradaki süreyi "kesme kuyruğa alındı" olarak gösterir.
 */
export const InterruptRequested = ev(
  "interrupt.requested",
  z.object({ ...TurnRef, by: UserRef }),
);

export const InterruptApplied = ev(
  "interrupt.applied",
  z.object({
    ...TurnRef,
    /**
     * `graceful`: SDK'nın kendi `interrupt()`'ı işe yaradı.
     * `abort`: abortController devreye girdi (daha sert).
     * `hard_kill`: 30 sn'de kapanmadı, runner öldürüldü.
     */
    mode: z.enum(["graceful", "abort", "hard_kill"]),
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
  MessageQueued,
  MessageCancelled,
  MessageReceived,
  TurnStarted,
  AgentText,
  TurnCompleted,
  TurnFailed,
  ToolCall,
  ToolResult,
  ToolDenied,
  FileChanged,
  CheckpointCreated,
  RoomRepoInitialized,
  AgentWorkspaceReady,
  DiffUpdated,
  JournalUpdated,
  TaskCreated,
  TaskUpdated,
  AccessRequested,
  AccessResolved,
  ApprovalRequested,
  ApprovalResolved,
  CommentOnLine,
  ReviewSubmitted,
  CommentResolved,
  CommentReopened,
  PresenceUpdated,
  DriverClaimed,
  DriverReleased,
  DriverHandedOff,
  InterruptRequested,
  InterruptApplied,
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
