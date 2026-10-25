import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  RPC_LIMITS,
  ROOMS_RPC_SOCKET_DIR,
  ROOMS_RPC_SOCKET_ENV,
  ROOMS_RPC_SOCKET_NAME,
  RpcRequest,
  RpcResponse,
} from "@agent-rooms/protocol";

/**
 * Runner tarafının RPC köprüsü — Hafta 8, Adım 4. İki koşum ortamı ortak.
 *
 * Defter tool'larını sunan MCP süreci (Adım 5) runner'ın çocuğu değil, koşum
 * ortamının (Gemini CLI / Claude SDK) çocuğu: runner'ın stdin/stdout'una
 * erişemez. Bu köprü agent'ın HOME'unda bir Unix soketi açar, soketten gelen
 * `RpcRequest`'i host'a `rpc` satırı olarak yollar, `rpc_result`'ı geri
 * taşır.
 *
 * Soket kimlik TAŞIMAZ. Kimliği host bilir (hangi runner'ın hattı); soketin
 * izinleri yalnızca öteki agent'ların araya girmesini engeller: dizin 0700,
 * soket 0600, ikisi de agent'ın kullanıcısına ait (runner o kullanıcıyla
 * koşuyor, Hafta 7).
 *
 * İstemcinin `id`'si host'a GİTMEZ: aynı anda bağlanan iki istemci aynı `id`'yi
 * kullanabilir. Her istek host'a yeni bir id ile gider, cevap eşlenip
 * istemcinin kendi id'siyle döner.
 */

/** Tek satırın üst sınırı — bir defter yazımı bunun çok altında. */
const MAX_LINE_BYTES = 256 * 1024;

export function defaultRpcSocketPath(home: string): string {
  return path.posix.join(home, ROOMS_RPC_SOCKET_DIR, ROOMS_RPC_SOCKET_NAME);
}

/** Windows adlandırılmış kanalı (yalnızca testlerde): dosya izni yok. */
const isPipe = (p: string): boolean => p.startsWith("\\\\");

export interface RpcBridgeOptions {
  socketPath: string;
  /** Host'a `rpc` satırı yazar (runner'ın `out`'u). */
  send: (out: { kind: "rpc"; id: string; method: string; params: unknown }) => void;
  timeoutMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

interface Pending {
  socket: net.Socket;
  clientId: string;
  timer: NodeJS.Timeout;
}

export class RpcBridge {
  private readonly opts: RpcBridgeOptions;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private server: net.Server | null = null;

  constructor(opts: RpcBridgeOptions) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? RPC_LIMITS.runnerTimeoutMs;
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  /** Host'ta cevabı beklenen istek sayısı. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async listen(): Promise<void> {
    const p = this.opts.socketPath;
    if (!isPipe(p)) {
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      // Önceki runner'dan kalan soket dosyası `listen`'i EADDRINUSE ile düşürür.
      rmSync(p, { force: true });
    }
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // umask'a bırakılmaz: soket açıkça yalnızca sahibine.
    if (!isPipe(p)) chmodSync(p, 0o600);
    this.server = server;
  }

  /** Host'tan `rpc_result` geldi. */
  onResult(r: RpcResponse): void {
    const p = this.pending.get(r.id);
    if (!p) {
      // Zaman aşımına uğramış ya da istemcisi kapanmış bir istek.
      this.opts.log?.("warn", `beklenmeyen rpc_result: ${r.id}`);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(r.id);
    reply(p.socket, { id: p.clientId, ok: r.ok, data: r.data, error: r.error });
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!isPipe(this.opts.socketPath)) rmSync(this.opts.socketPath, { force: true });
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.request(socket, line);
      }
      // Satır sonu gelmeden büyüyen tampon: belleği şişirmesin.
      if (Buffer.byteLength(buf) > MAX_LINE_BYTES) {
        this.opts.log?.("warn", "rpc isteği çok büyük, bağlantı kapatıldı");
        socket.destroy();
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      for (const [id, p] of this.pending) {
        if (p.socket !== socket) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
    });
  }

  private request(socket: net.Socket, line: string): void {
    let req: RpcRequest;
    try {
      req = RpcRequest.parse(JSON.parse(line));
    } catch {
      reply(socket, { id: "?", ok: false, error: "geçersiz istek: {id, method, params} bekleniyor" });
      return;
    }
    const hostId = randomUUID();
    const timer = setTimeout(() => {
      this.pending.delete(hostId);
      reply(socket, { id: req.id, ok: false, error: `host ${this.timeoutMs} ms içinde cevap vermedi` });
    }, this.timeoutMs);
    this.pending.set(hostId, { socket, clientId: req.id, timer });
    this.opts.send({ kind: "rpc", id: hostId, method: req.method, params: req.params });
  }
}

/**
 * Runner açılışı: köprüyü agent'ın HOME'unda açar ve yolunu
 * `ROOMS_RPC_SOCKET`'e yazar — koşum ortamı ve onun başlattığı MCP süreci
 * ortamı runner'dan devralır, yol tek yerde belirlenir.
 *
 * Açılamazsa runner yine kalkar (agent defter olmadan da kod yazabilir) ama
 * bunu `error` olarak söyler: defter tool'ları o agent'ta çalışmayacak.
 */
export async function startRpcBridge(opts: Omit<RpcBridgeOptions, "socketPath">): Promise<RpcBridge | null> {
  const socketPath = process.env[ROOMS_RPC_SOCKET_ENV] || defaultRpcSocketPath(process.env.HOME || homedir());
  const bridge = new RpcBridge({ ...opts, socketPath });
  try {
    await bridge.listen();
  } catch (err) {
    opts.log?.("error", `rpc soketi açılamadı (${socketPath}): ${String(err)} — defter tool'ları çalışmayacak`);
    return null;
  }
  process.env[ROOMS_RPC_SOCKET_ENV] = socketPath;
  return bridge;
}

function reply(socket: net.Socket, r: RpcResponse): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(JSON.stringify(r) + "\n");
}

/**
 * Soket istemcisi — MCP süreci (Adım 5) bunu kullanır. Tek istek, tek cevap,
 * sonra bağlantı kapanır.
 */
export async function rpcCall(
  socketPath: string,
  method: string,
  params: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<RpcResponse> {
  const timeoutMs = opts.timeoutMs ?? RPC_LIMITS.runnerTimeoutMs + 1_000;
  const id = randomUUID();
  return new Promise<RpcResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buf = "";
    const done = (err: Error | null, r?: RpcResponse): void => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(r!);
    };
    const timer = setTimeout(() => done(new Error(`rpc ${timeoutMs} ms içinde dönmedi`)), timeoutMs);
    socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const r = RpcResponse.parse(JSON.parse(buf.slice(0, nl)));
        if (r.id !== id) return done(new Error(`rpc cevabı başka bir isteğin: ${r.id}`));
        done(null, r);
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("error", (err) => done(err));
    socket.on("close", () => done(new Error("rpc bağlantısı cevapsız kapandı")));
  });
}
