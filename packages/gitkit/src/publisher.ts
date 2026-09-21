import type { CheckpointKind, FileDiff, NewRoomEvent } from "@agent-rooms/protocol";
import { createCheckpoint, newCheckpointId } from "./checkpoint.js";
import { diffTrees, fingerprint, incremental, splitByBudget } from "./diff.js";
import { currentTree } from "./tree.js";

/**
 * Canlı diff yayımcısı — runner'ın içinde koşar.
 *
 * İki koşum ortamı (claude, gemini) AYNI yayımcıyı kullanır. İki kopya
 * olsaydı biri artımlı filtresini, diğeri debounce'unu farklı yapardı ve fark
 * ancak "Gemini odasında diff geç geliyor" diye görünürdü.
 *
 * Tasarım kararları:
 *
 * - **Hook diff hesaplamaz.** `PostToolUse` yalnızca kirli bayrağını kaldırır;
 *   hesap 300 ms debounce'lu bir işe düşer. Her `Edit` çağrısında tam bir
 *   `git add -A` + diff koşturmak, on dosyaya dokunan bir turn'de agent'ı
 *   bekletir.
 * - **Aynı anda tek yayım.** Çalışırken gelen tetik yayımı ikiye çıkarmaz,
 *   biten yayımın ardından bir kez daha koşturur.
 * - **Bütçeyi aşan dosyalar ertelenir** ve parmak izleri İŞARETLENMEZ:
 *   sonraki turda tekrar "değişmiş" sayılıp giderler.
 */

export interface DiffPublisherOptions {
  /** Agent'ın workspace'i. */
  cwd: string;
  agent: string;
  roomId: string;
  sessionId: string;
  emit: (event: NewRoomEvent) => void;
  /**
   * Taban. `null` ise canlı diff YAYIMLANMAZ: sessizce yanlış bir tabana göre
   * diff göstermektense hiç göstermemek doğru.
   */
  base: { checkpointId: string; treeSha: string } | null;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  debounceMs?: number;
}

export const DEFAULT_DEBOUNCE_MS = 300;

export class DiffPublisher {
  private base: { checkpointId: string; treeSha: string } | null;
  /** Son YAYIMLANAN hâl: path → parmak izi. Artımlı filtrenin hafızası. */
  private sent = new Map<string, string>();
  private dirty = false;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Yayım sırasında hangi turn'ün içindeyiz — event'teki `messageId`. */
  private messageId: string | null = null;
  private stopped = false;

  constructor(private readonly opts: DiffPublisherOptions) {
    this.base = opts.base;
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.opts.log?.(level, msg);
  }

  get enabled(): boolean {
    return this.base !== null;
  }

  get baseCheckpointId(): string | null {
    return this.base?.checkpointId ?? null;
  }

  /** Bir tool çağrısı dosya değiştirmiş olabilir. Hesap debounce'a düşer. */
  markDirty(messageId: string | null): void {
    if (!this.base || this.stopped) return;
    this.dirty = true;
    this.messageId = messageId;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /**
   * Beklemeden yayımla ve BİTMESİNİ BEKLE.
   *
   * Turn bitiminde çağrılır: `result` mesajından sonra, `turn_end`'den önce.
   * Debounce'a bırakılsaydı turn kapandıktan sonra gelen bir `diff.updated`
   * "hangi turn'ün işi" sorusunu cevapsız bırakırdı.
   */
  async flush(messageId: string | null): Promise<void> {
    if (!this.base || this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = true;
    this.messageId = messageId;
    await this.run();
  }

  /**
   * Taban değişti (manuel checkpoint). Artımlı harita SIFIRLANIR ve yeni
   * tabana göre TAM bir diff yayımlanır — sıfırlamasaydık eski tabanda
   * "değişmemiş" sayılan dosyalar yeni tabanda hiç görünmezdi.
   */
  async setBase(base: { checkpointId: string; treeSha: string }): Promise<void> {
    this.base = base;
    this.sent = new Map();
    await this.flush(null);
  }

  /**
   * Checkpoint al ve `checkpoint.created` yaz.
   *
   * `becomesBase` yalnızca baseline ve manuel checkpoint'lerde true; turn
   * checkpoint'i tabanı KAYDIRMAZ, yoksa "bu oturumda ne değişti" sorusu her
   * turn'de sıfırlanırdı.
   */
  async checkpoint(
    kind: CheckpointKind,
    label: string,
    messageId: string | null,
  ): Promise<{ checkpointId: string; commitSha: string; treeSha: string }> {
    const cp = await createCheckpoint(this.opts.cwd, newCheckpointId(), label);
    this.opts.emit({
      roomId: this.opts.roomId,
      sessionId: this.opts.sessionId,
      actor: { kind: "agent", name: this.opts.agent },
      type: "checkpoint.created",
      payload: {
        agent: this.opts.agent,
        checkpointId: cp.checkpointId,
        kind,
        label,
        commitSha: cp.commitSha,
        treeSha: cp.treeSha,
        messageId,
        by: null,
        becomesBase: kind !== "turn",
      },
    } as NewRoomEvent);
    return cp;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Aynı anda tek yayım; çalışırken gelen tetik bittiğinde bir kez daha koşar. */
  private run(): Promise<void> {
    if (this.running) {
      return this.running.then(() => (this.dirty ? this.run() : undefined));
    }
    this.running = this.publishOnce()
      .catch((err: unknown) => {
        // Diff üretilemedi: agent'ı durdurmaz. Yayım bir sunum işidir.
        this.log("warn", `diff yayımlanamadı: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running.then(() => (this.dirty && !this.stopped ? this.run() : undefined));
  }

  private async publishOnce(): Promise<void> {
    const base = this.base;
    if (!base) return;
    this.dirty = false;
    const messageId = this.messageId;

    const cur = await currentTree(this.opts.cwd);
    const files = await diffTrees(this.opts.cwd, base.treeSha, cur);
    const { changed } = incremental(this.sent, files);
    if (changed.length === 0) return;

    const { send, defer } = splitByBudget(changed);

    /**
     * Parmak izi YALNIZCA gönderilenler için işaretlenir. Ertelenen dosya
     * işaretlenseydi bir daha hiç gönderilmez, ekranda hiç görünmezdi.
     */
    const committed = new Map(this.sent);
    for (const f of send) {
      if (f.status === "clean") committed.delete(f.path);
      else committed.set(f.path, fingerprint(f));
    }
    this.sent = committed;

    this.opts.emit({
      roomId: this.opts.roomId,
      sessionId: this.opts.sessionId,
      actor: { kind: "agent", name: this.opts.agent },
      type: "diff.updated",
      payload: {
        agent: this.opts.agent,
        messageId,
        baseCheckpointId: base.checkpointId,
        files: send as FileDiff[],
      },
    } as NewRoomEvent);

    // Bütçeye sığmayanlar sıradaki yayıma kalır.
    if (defer.length > 0) this.dirty = true;
  }
}
