import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ContractsWatcher, DiffPublisher } from "@agent-rooms/gitkit";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import {
  AgentConfig,
  PROTOCOL_VERSION,
  ROOM_TOOLCHAIN_PROBES,
  claudeSystemAppend,
  RunnerCommand,
  RunnerOutput,
  resolveSdkTools,
  roomRelativePath,
} from "@agent-rooms/protocol";
import { mapMessage } from "./map-messages.js";

/**
 * Container içinde, agent başına bir süreç.
 *
 * stdout SADECE NDJSON protokolüdür — buraya kaçan tek bir satır host'un
 * ayrıştırmasını bozar. Bu yüzden console.* stderr'e yönlendiriliyor.
 *
 * SDK burada koşar, host'ta değil: `Bash` ve `Edit` tool'ları sürecin
 * bulunduğu yerde çalışır. SDK host'ta koşsaydı agent host dosya sisteminde
 * komut çalıştırırdı ve sandbox anlamsızlaşırdı.
 */

const toStderr = (...args: unknown[]): void => {
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
};
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`runner: ${name} tanımlı değil\n`);
    process.exit(2);
  }
  return value;
}

const roomId = required("ROOM_ID");
const sessionId = required("SESSION_ID");
const agent = AgentConfig.parse(JSON.parse(required("ROOM_AGENT_CONFIG")));
const tools = resolveSdkTools(agent);
const allowed = new Set(tools.allow);

/**
 * Ortamda ne olduğunu ÖLÇ (ikizi runner-gemini'de).
 *
 * Elle yazılmış bir liste oda imajıyla kayar; `node --version` kayamaz. Agent
 * "Python var mı" sorusunu deneyip öğrenmek zorunda kalmasın: ortamda olmayan
 * bir şeyi istemek, agent'ın yarım iş yapıp durmasına yol açıyor (gerçekte
 * oldu: Django görevinde Python yoktu).
 */
const probeToolchain = (): Array<{ label: string; version: string | null }> =>
  ROOM_TOOLCHAIN_PROBES.map((probe) => {
    try {
      const res = spawnSync(probe.cmd, probe.args, { encoding: "utf8", timeout: 5_000 });
      const out =
        `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split(/\r?\n/)[0] ?? "";
      return { label: probe.label, version: res.status === 0 && out.length > 0 ? out : null };
    } catch {
      return { label: probe.label, version: null };
    }
  });

/** Bir kez ölçülür: agent'ın ömrü boyunca ortam değişmiyor. */
const toolchain = probeToolchain();

let sdkSessionId: string | null = process.env.RESUME_SESSION_ID || null;
let busy = false;
let abort: AbortController | null = null;
/** Koşan turn'ün mesajı — geç gelen bir kesme komutu yanlış turn'ü vurmasın. */
let currentMessageId: string | null = null;
/**
 * Bu turn KESİLİYOR. `turn.failed` sebebini ve `interrupt.applied` event'ini
 * bu bayrak belirler: kapanma ile kesilme aynı şey değil.
 */
let interrupting = false;

const out = (o: RunnerOutput): void => {
  process.stdout.write(JSON.stringify(RunnerOutput.parse(o)) + "\n");
};
const emit = (event: NewRoomEvent): void => out({ kind: "event", event });

const agentActor = { kind: "agent", name: agent.name } as const;
const envelope = { roomId, sessionId };

/**
 * Canlı diff yayımcısı.
 *
 * Taban SUNUCUDAN geliyor (`gitkit init-workspace` ile agent başlatılmadan
 * önce alınıyor). Runner kendisi taban ÜRETMEZ: iki yerde taban üretmek
 * "diff neye göre" sorusunu iki farklı cevaba bölerdi.
 */
const baseCheckpointId = process.env.DIFF_BASE_CHECKPOINT_ID;
const baseTree = process.env.DIFF_BASE_TREE;
const diff = new DiffPublisher({
  cwd: process.cwd(),
  agent: agent.name,
  roomId,
  sessionId,
  emit: (event) => emit(event),
  base: baseCheckpointId && baseTree ? { checkpointId: baseCheckpointId, treeSha: baseTree } : null,
  log: (level, msg) => out({ kind: "log", level, msg }),
});
/**
 * `contracts/` takibi (Hafta 7, Adim 7).
 *
 * Diff yayimcisi agent'in KENDI deposunu izliyor; contracts onun disinda.
 * Ilk tarama TABANI kuruyor: agent baslamadan once orada olan dosyalar
 * "agent degistirdi" diye yayimlanmiyor.
 */
const contracts = new ContractsWatcher({
  roomId,
  sessionId,
  agent: agent.name,
  emit: (event) => emit(event),
  log: (level, msg) => out({ kind: "log", level, msg }),
});
await contracts.scan(null);

if (!diff.enabled) {
  out({
    kind: "log",
    level: "warn",
    msg: "diff tabanı yok (DIFF_BASE_*) — canlı diff yayımlanmayacak",
  });
}

/**
 * Izin denetimi (Hafta 7, Adim 9) — runner OLCER, DUZELTMEZ.
 *
 * Agent kendi worktree dizininin sahibi oldugu icin `chmod 777 .` yapabilir.
 * Runner duzeltemez: agent kullanicisiyla kosuyor ve `chown`/`chmod` geri
 * alma yetkisi ayricalik ister. Bu yuzden yalnizca bildiriyor; AgentManager
 * root exec ile duzeltip TEK bir `isolation.violation` event'i yaziyor.
 *
 * Beklenen deger ortamdan geliyor (ISOLATION_EXPECTED); sunucu izin planindan
 * uretiyor. Runner kendi "dogru izin" tanimini tasisaydi plan ile iki kopya
 * olurdu ve biri digerinden kayardi.
 */
async function reportIsolationDrift(): Promise<void> {
  const expected = process.env.ISOLATION_EXPECTED;
  if (!expected) return;
  try {
    const res = spawnSync("stat", ["-c", "%U:%G %a", process.cwd()], { encoding: "utf8" });
    const actual = (res.stdout ?? "").trim();
    if (!actual || actual === expected) return;
    out({ kind: "isolation_drift", path: process.cwd(), actual });
  } catch {
    // stat yoksa sessiz gec: denetimin ikinci kopyasi sunucuda 5 dakikada bir kosuyor.
  }
}

async function runTurn(messageId: string, text: string, ac: AbortController): Promise<void> {
  const ctx = { roomId, sessionId, agent: agent.name, messageId };
  const turn = { agent: agent.name, messageId };
  let ok = false;
  /**
   * Bitiş event'i yazıldı mı. "Her messageId için TAM OLARAK BİR bitiş
   * event'i" kuralı: SDK `result` verdiyse turn.completed yazılmıştır ve
   * üstüne turn.failed yazmak log'u yalancı yapar.
   */
  let sawTerminal = false;

  try {
    const q = query({
      prompt: text,
      options: {
        cwd: process.cwd(),
        model: process.env.AGENT_MODEL,
        resume: sdkSessionId ?? undefined,
        // Odada birden fazla insan var: her mesaj `[İsim]: ` ile geliyor.
        // Not tek bir sabitten geliyor ve her agent için aynı.
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: claudeSystemAppend(agent.systemPrompt, toolchain),
        },
        // Host/container ayar dosyalarını yükleme — yetki sadece YAML'dan gelir.
        settingSources: [],
        tools: tools.allow, // katman (a): agent sadece bunları görür
        allowedTools: tools.allow, // sorusuz onaylı
        disallowedTools: tools.deny, // katman (b)
        // İzin soracak insan yok; soru gerektiren her şey reddedilir.
        permissionPrompts: "none",
        maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 30),
        maxBudgetUsd: Number(process.env.AGENT_MAX_BUDGET_USD ?? 1),
        abortController: ac,
        hooks: {
          // katman (c): SDK ne derse desin, YAML son sözü söyler.
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  const tool = (input as { tool_name?: string }).tool_name ?? "";
                  if (allowed.has(tool)) return {};
                  emit({
                    ...envelope,
                    actor: agentActor,
                    type: "tool.denied",
                    payload: { ...turn, tool, reason: "rol YAML'ında toolsAllow dışında" },
                  } as NewRoomEvent);
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "deny" as const,
                      permissionDecisionReason: `${tool} bu agent için kapalı`,
                    },
                  };
                },
              ],
            },
          ],
          PostToolUse: [
            {
              /**
               * **Bash DA DAHİL.** `sed -i`, kod üreticiler ve `npm install`
               * dosya değiştirir; matcher'ı yalnızca Edit/Write ile
               * sınırlamak "agent dosyayı değiştirdi ama diff'te yok"
               * demekti.
               */
              matcher: "Edit|Write|NotebookEdit|Bash",
              hooks: [
                async (input) => {
                  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
                  const path = i.tool_input?.file_path ?? i.tool_input?.notebook_path;
                  // `file.changed` yalnızca YOLU bilinen araçlar için: Bash'in
                  // neye dokunduğunu tool girdisinden okumak metin kazımak olurdu.
                  if (typeof path === "string" && path.length > 0) {
                    emit({
                      ...envelope,
                      actor: agentActor,
                      type: "file.changed",
                      payload: { ...turn, path: roomRelativePath(path), tool: i.tool_name ?? "" },
                    } as NewRoomEvent);
                  }
                  /**
                   * Hook diff HESAPLAMAZ: yalnızca kirli bayrağını kaldırır.
                   * Her araç çağrısında `git add -A` + diff koşturmak agent'ı
                   * kendi aletinin içinde bekletirdi.
                   */
                  diff.markDirty(messageId);
                  /*
                   * contracts/ agent'in cwd'si DISINDA; diff yayimcisi onu
                   * gormuyor. Yolu bilinen aracta dogrudan, Bash'te tam
                   * tarama ile bakiyoruz.
                   */
                  if (typeof path === "string" && path.length > 0) {
                    await contracts.onToolPath(path, messageId).catch(() => undefined);
                  } else {
                    await contracts.scan(messageId).catch(() => undefined);
                  }
                  return {};
                },
              ],
            },
          ],
        },
      },
    });

    for await (const msg of q) {
      const mapped = mapMessage(msg, ctx);
      if (mapped.sdkSessionId) sdkSessionId = mapped.sdkSessionId;
      for (const event of mapped.events) emit(event);
      const m = msg as { type?: string; subtype?: string };
      if (m.type === "result") {
        ok = m.subtype === "success";
        sawTerminal = true;
      }
    }
  } catch (err) {
    if (!sawTerminal) {
      emit({
        ...envelope,
        actor: agentActor,
        type: "turn.failed",
        payload: {
          ...turn,
          // Kesilme ile kapanma ayrı sebepler: "neden durdu" sorusunun
          // cevabı log'da durmalı.
          reason: interrupting ? "interrupted" : ac.signal.aborted ? "aborted" : "sdk_error",
          error: String(err).slice(0, 2000),
        },
      } as NewRoomEvent);
      sawTerminal = true;
    }
    ok = false;
  } finally {
    /**
     * Kesme GERÇEKTEN uygulandı. `interrupt.requested` ile arasındaki süre
     * sıfır değil — UI o aralığı "kesme kuyruğa alındı" diye gösteriyor.
     *
     * `mode: "abort"`: kurulu SDK'da mesaj başına `query()` + `resume` yapısı
     * kullanıldığı için kesme abortController ile yapılıyor (README "Karar
     * notları"). Streaming input'a geçilince `graceful` de mümkün olacak.
     */
    if (interrupting) {
      emit({
        ...envelope,
        actor: agentActor,
        type: "interrupt.applied",
        payload: { ...turn, mode: "abort" },
      } as NewRoomEvent);
      interrupting = false;
    }

    /**
     * Turn bitti: SON bir diff yayımı zorla yapılır, ardından TURN
     * CHECKPOINT'i alınır. Sıra önemli — önce checkpoint alınsaydı
     * checkpoint'in ağacı ile yayımlanan diff aynı ana bakmazdı.
     *
     * Turn checkpoint'i tabanı KAYDIRMAZ (`becomesBase: false`): "bu oturumda
     * ne değişti" sorusu her turn'de sıfırlansaydı Diff sekmesi hiçbir zaman
     * oturumun tamamını göstermezdi. Tek işi "Ayşe'nin 14:02 mesajından
     * sonrası" diye geri bakılabilmesi.
     */
    if (diff.enabled) {
      await diff.flush(messageId).catch(() => undefined);
      await diff
        .checkpoint("turn", `turn sonu: ${messageId.slice(0, 8)}`, messageId)
        .catch((err: unknown) =>
          out({ kind: "log", level: "warn", msg: `turn checkpoint'i alınamadı: ${String(err)}` }),
        );
    }

    /*
     * Turn sonunda contracts taramasi (Hafta 7, Adim 7).
     *
     * Tool girdisinden okunamayan degisiklikleri burada yakaliyoruz:
     * `sed -i`, `cat >` ve kod ureticileri sozlesmeyi tool yolunu
     * bildirmeden degistirebiliyor.
     */
    await contracts.scan(messageId).catch(() => undefined);

    // Izin denetimi: agent kendi klasorunun iznini gevsetmis olabilir.
    await reportIsolationDrift();

    // Her durumda gönderilir — host bunu görmeden agent'ı idle'a almaz.
    out({ kind: "turn_end", messageId, sdkSessionId, ok });
  }
}

out({ kind: "ready", pid: process.pid, protocolVersion: PROTOCOL_VERSION });
setInterval(() => out({ kind: "heartbeat", busy }), 5_000);

const shutdown = (): void => {
  abort?.abort();
  setTimeout(() => process.exit(0), 3_000);
};

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  let cmd: RunnerCommand;
  try {
    cmd = RunnerCommand.parse(JSON.parse(line));
  } catch (err) {
    out({ kind: "log", level: "error", msg: `komut ayrıştırılamadı: ${String(err)}` });
    return;
  }

  if (cmd.kind === "shutdown") {
    diff.stop();
    shutdown();
    return;
  }

  /**
   * Taban değişti (sunucu manuel checkpoint aldı). Artımlı harita sıfırlanır
   * ve yeni tabana göre TAM diff yayımlanır.
   */
  if (cmd.kind === "set_base") {
    void diff
      .setBase({ checkpointId: cmd.checkpointId, treeSha: cmd.treeSha })
      .catch((err: unknown) =>
        out({ kind: "log", level: "warn", msg: `taban değiştirilemedi: ${String(err)}` }),
      );
    return;
  }

  /**
   * Kesme. Yetki host tarafında (yalnızca sürücü); burada tek kontrol
   * "hangi turn": geç kalmış bir kesme komutu bir sonraki mesajı öldürmesin.
   */
  if (cmd.kind === "interrupt") {
    if (!busy || cmd.messageId !== currentMessageId) {
      out({ kind: "log", level: "warn", msg: `kesilecek turn yok: ${cmd.messageId}` });
      return;
    }
    interrupting = true;
    abort?.abort();
    return;
  }

  /**
   * Sıralama artık SUNUCUNUN işi: kuyruk agent başına tek koşan mesaj
   * garantisi veriyor (`agent_queue_single_running`). Yine de burada bir
   * emniyet kalıyor — runner'a iki `run` gelirse ikincisi sessizce kabul
   * edilip context'i bozmasın.
   */
  if (busy) {
    out({ kind: "log", level: "warn", msg: `meşgul, reddedildi: ${cmd.messageId}` });
    return;
  }

  busy = true;
  const ac = new AbortController();
  abort = ac;
  currentMessageId = cmd.messageId;
  void runTurn(cmd.messageId, cmd.text, ac).finally(() => {
    busy = false;
    abort = null;
    currentMessageId = null;
    interrupting = false;
  });
});

// Host bağlantısı koptu: uçuştaki turn'ü iptal et ve çık ki container içinde
// sahipsiz runner kalmasın.
rl.on("close", shutdown);
