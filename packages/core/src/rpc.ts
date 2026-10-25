import type pg from "pg";
import { RPC_LIMITS, type RpcMethod, type RpcResponse } from "@agent-rooms/protocol";
import { getPool } from "./db/pool.js";
import { readJournalState, writeJournalEntry } from "./journal.js";

/**
 * Runner RPC kanalının host tarafı — Hafta 8, Adım 4.
 *
 * Runner'ın DB erişimi yok (Değişmez Kural 3); defter tool'ları (Adım 5)
 * host'a `rpc` satırıyla sorar, cevap `rpc_result` komutuyla döner.
 *
 * KİMLİK HOST'UN: handler'a verilen `{ roomId, agentName }` isteğin geldiği
 * runner hattından gelir. `params` içinde başka bir agent adı yazsa da yok
 * sayılır — `writeJournalEntry` payload'daki `agent`'ı zaten atıyor, ama bu
 * kural ona güvenmez: kimlik `params`'tan hiç OKUNMAZ.
 *
 * `ok: false` yalnızca TAŞIMA hatasıdır: bilinmeyen method, zaman aşımı, açık
 * RPC sınırı, handler istisnası. Defterin doğrulama reddi bir SONUÇTUR ve
 * `data` içinde döner (`accepted: false` + alanlar) — Adım 5 `journal.rejected`
 * event'ini ve öğretici hata metnini ondan kurar.
 *
 * RPC trafiği event log'a YAZILMAZ: yazımın sonucu zaten
 * `journal.entry_written` olarak orada.
 */

export interface RpcContext {
  roomId: string;
  agentName: string;
  /** Koşan turn; agent boştaysa null. */
  messageId: string | null;
  pool: pg.Pool;
}

export type RpcHandler = (ctx: RpcContext, params: unknown) => Promise<unknown>;

export type JournalWriteRpcResult =
  | { accepted: true; version: number }
  | { accepted: false; status: 400 | 404 | 409; fields: string[]; message: string };

export const JOURNAL_RPC: Record<RpcMethod, RpcHandler> = {
  "journal.read": (ctx) => readJournalState(ctx.roomId, ctx.pool),
  "journal.write": async (ctx, params): Promise<JournalWriteRpcResult> => {
    const r = await writeJournalEntry(
      {
        roomId: ctx.roomId,
        agentName: ctx.agentName,
        messageId: ctx.messageId,
        source: "agent",
        patch: params,
        actor: { kind: "agent", name: ctx.agentName },
      },
      ctx.pool,
    );
    return r.ok
      ? { accepted: true, version: r.version }
      : { accepted: false, status: r.status, fields: r.fields, message: r.message };
  },
};

export interface RpcHostOptions {
  roomId: string;
  agentName: string;
  /** Koşan turn'ün mesajı — her istekte sorulur, turn'ler arasında değişir. */
  currentMessageId: () => Promise<string | null>;
  send: (result: RpcResponse) => void;
  handlers?: Readonly<Record<string, RpcHandler>>;
  pool?: pg.Pool;
  timeoutMs?: number;
  maxOpen?: number;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

/** Agent başına bir tane; sınır ve sayaç o agent'ın. */
export class RpcHost {
  private open = 0;
  private readonly handlers: Readonly<Record<string, RpcHandler>>;
  private readonly pool: pg.Pool;
  private readonly timeoutMs: number;
  private readonly maxOpen: number;

  constructor(private readonly opts: RpcHostOptions) {
    this.handlers = opts.handlers ?? JOURNAL_RPC;
    this.pool = opts.pool ?? getPool();
    this.timeoutMs = opts.timeoutMs ?? RPC_LIMITS.timeoutMs;
    this.maxOpen = opts.maxOpen ?? RPC_LIMITS.maxOpen;
  }

  /** Açık (handler'ı henüz bitmemiş) RPC sayısı. */
  get openCount(): number {
    return this.open;
  }

  /**
   * İsteği işler ve cevabı `send` ile yollar. Asla fırlatmaz.
   *
   * Zaman aşımında cevap hemen `ok: false` gider ama handler DURDURULMAZ
   * (DB transaction'ı yarıda kesilemez) ve bitene kadar sınırdan düşmez.
   * Sayaç cevaba değil handler'a bağlı: asılı kalan handler'lar birikirse
   * yeni istekler sınıra takılır, host'u boğmaz. Bedeli: zaman aşımından
   * sonra yazım yine de olmuş olabilir; Adım 5'in hata metni agent'a
   * "sonuç bilinmiyor, read_journal ile bak" demeli.
   */
  async handle(req: { id: string; method: string; params: unknown }): Promise<void> {
    const reply = (r: Omit<RpcResponse, "id">): void => {
      try {
        this.opts.send({ id: req.id, ...r });
      } catch (err) {
        // Runner kapanmış olabilir; cevabın gidecek yeri yok.
        this.opts.log?.("warn", `rpc cevabı gönderilemedi (${req.method}): ${String(err)}`);
      }
    };

    // `hasOwn`: `toString` gibi prototip adları method sayılmasın.
    const handler = Object.hasOwn(this.handlers, req.method) ? this.handlers[req.method] : undefined;
    if (!handler) return reply({ ok: false, error: `bilinmeyen method: ${req.method}` });
    if (this.open >= this.maxOpen) {
      return reply({ ok: false, error: `aynı anda en fazla ${this.maxOpen} açık istek` });
    }

    this.open += 1;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      this.opts.log?.("warn", `rpc zaman aşımı (${req.method}, ${this.timeoutMs} ms)`);
      reply({ ok: false, error: `zaman aşımı (${this.timeoutMs} ms); sonuç bilinmiyor` });
    }, this.timeoutMs);

    try {
      const ctx: RpcContext = {
        roomId: this.opts.roomId,
        agentName: this.opts.agentName,
        messageId: await this.opts.currentMessageId(),
        pool: this.pool,
      };
      const data = await handler(ctx, req.params);
      if (!settled) reply({ ok: true, data });
    } catch (err) {
      this.opts.log?.("error", `rpc handler hatası (${req.method}): ${String(err)}`);
      if (!settled) reply({ ok: false, error: `host hatası: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      settled = true;
      clearTimeout(timer);
      this.open -= 1;
    }
  }
}
