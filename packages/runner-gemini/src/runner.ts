import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { ContractsWatcher, DiffPublisher } from "@agent-rooms/gitkit";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import {
  AgentConfig,
  PROTOCOL_VERSION,
  ROOM_TOOLCHAIN_PROBES,
  RunnerCommand,
  RunnerOutput,
  geminiContextFile,
  roomLayoutNote,
} from "@agent-rooms/protocol";
import {
  createRetryTracker,
  geminiIncludeDirectories,
  mapStreamLine,
  resolveGeminiTools,
  type RetrySignal,
} from "./map-stream.js";

/**
 * Gemini CLI koşum ortamı — Claude runner'ın kardeşi, aynı NDJSON'u konuşur.
 *
 * Host tarafında hiçbir şey değişmez: AgentManager bu sürecin Gemini mi Claude
 * mı olduğunu bilmiyor, sadece protokolü görüyor.
 *
 * ── Claude runner'dan üç yapısal fark ───────────────────────────────────────
 *
 * 1. TURN BAŞINA YENİ SÜREÇ. Gemini CLI `-p` ile tek seferlik çalışır; SDK gibi
 *    uzun ömürlü bir oturum nesnesi yok. Bu yüzden her `run` komutu yeni bir
 *    `gemini` süreci açar. Süreklilik oturum kimliğiyle sağlanır:
 *      ilk turn  → --session-id <uuid>   (kimliği BİZ üretiriz)
 *      sonraki   → --resume <uuid>
 *    Ölçüldü: --session-id var olan kimlikte hata veriyor, --resume hatırlıyor.
 *
 * 2. TOOL KAPISI ZAYIF. Gemini'de tool çalışmadan önce araya girip reddedemiyoruz
 *    (Claude'daki PreToolUse hook'unun karşılığını henüz kurmadık). Yetki
 *    `--allowed-tools` ile ÖNDEN kısıtlanır; buna rağmen izin dışı bir çağrı
 *    akışta görünürse `tool.denied` olarak SAPTANIR — engellenmez.
 *    Bu fark README'de ve docs/runtime-gemini.md'de açıkça yazılıdır.
 *
 * 3. `--approval-mode yolo` KULLANILMAZ. Gemini'nin kendi kapısını tamamen
 *    kapatır. Bunun yerine auto_edit + --allowed-tools kullanılır.
 *
 * 4. SİSTEM PROMPT'U YERİNE `GEMINI.md`. Gemini CLI'da sistem prompt'u veren
 *    bir bayrak yok; rol YAML'ındaki `systemPrompt` bu koşum ortamına hiç
 *    ulaşmıyordu. CLI çalışma alanındaki `GEMINI.md`'yi bağlam olarak okuyor,
 *    runner da onu her başlangıçta rol YAML'ından yazıyor. Claude yolundaki
 *    `systemPrompt.append` ile birbirinin yedeği: biri olmasa diğeri rolü
 *    taşır.
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
    process.stderr.write(`runner-gemini: ${name} tanımlı değil\n`);
    process.exit(2);
  }
  return value;
}

const roomId = required("ROOM_ID");
const sessionId = required("SESSION_ID");
const agent = AgentConfig.parse(JSON.parse(required("ROOM_AGENT_CONFIG")));
const tools = resolveGeminiTools(agent);
const allowedTools = new Set(tools.allow);
// İmajda /opt/runner/gemini altında kurulu. GEMINI_BIN ile ezilebilir.
const geminiBin =
  process.env.GEMINI_BIN || "/opt/runner/gemini/node_modules/.bin/gemini";

/** Gemini oturum kimliği — ilk turn'de üretilir, sonra resume için kullanılır. */
let geminiSessionId: string | null = process.env.RESUME_SESSION_ID || null;
let busy = false;
let child: ChildProcess | null = null;
/** Koşan turn'ün mesajı — geç gelen kesme komutu bir sonraki turn'ü vurmasın. */
let currentMessageId: string | null = null;
/**
 * Bu turn KESİLİYOR. Kesilme ile "süreç kendi kendine öldü" aynı şey değil;
 * `turn.failed` sebebini bu bayrak belirliyor.
 */
let interrupting = false;
/** Kibar sinyalden sonra süreç ölmezse ne kadar beklenir. */
const SIGKILL_AFTER_MS = 5_000;
/**
 * Art arda en fazla başarısız sağlayıcı isteği — sunucudan (`AGENT_RETRY_BUDGET`).
 * Turn başına toplam sınır bunun `RETRY_TOTAL_FACTOR` katı (`createRetryTracker`).
 */
const RETRY_BUDGET = Math.max(1, Math.floor(Number(process.env.AGENT_RETRY_BUDGET) || 3));

/**
 * Süreci VE çocuklarını durdur.
 *
 * `child.kill()` yalnızca Gemini CLI'yı vurur; onun başlattığı kabuk komutu
 * (ör. `sleep 120`) yaşamaya devam eder ve turn kapanmaz. Sinyal GRUBA
 * gönderilir — süreç `detached: true` ile kendi grubunda başlatılıyor.
 */
const killTree = (proc: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void => {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // Grup yoksa (platform/izin) tek sürece düş: hiç denememekten iyi.
    try {
      proc.kill(signal);
    } catch {
      // Süreç zaten ölmüş.
    }
  }
};

const out = (o: RunnerOutput): void => {
  process.stdout.write(JSON.stringify(RunnerOutput.parse(o)) + "\n");
};
const emit = (event: NewRoomEvent): void => out({ kind: "event", event });

const envelope = { roomId, sessionId };
const agentActor = { kind: "agent", name: agent.name } as const;

/**
 * Canlı diff yayımcısı — Claude runner'la AYNI sınıf.
 *
 * Gemini'de `PostToolUse` hook'u yok; tetik akıştaki `tool.*` event'lerinden
 * geliyor (aşağıda `markDirtyFrom`). Sonuç aynı: dosya değiştiren her araç
 * çağrısından 300 ms sonra bir yayım.
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
 * Akıştan gelen bir event dosya değiştirmiş olabilir mi.
 *
 * Gemini tool çıktısının METNİNİ vermiyor, sadece durumunu; hangi dosyaya
 * dokunduğunu okumaya çalışmak metin kazımak olurdu. Bu yüzden ölçüt kaba:
 * bir tool çalıştıysa diff yeniden hesaplanır. Hesap zaten artımlı, boşuna
 * koşarsa hiçbir event üretmez.
 */
/**
 * Izin denetimi (Hafta 7, Adim 9) — runner OLCER, DUZELTMEZ.
 * Gerekce ve sozlesme packages/runner/src/runner.ts ile ayni.
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
    // Sunucudaki 5 dakikalik denetim yedegi.
  }
}

/**
 * Odanin yapisi — ortamdan okunur, runner uydurmaz.
 *
 * `ROOM_PEERS` ve `ROOM_CONTRACTS` sunucudan geliyor (AgentManager, oda
 * config'inden). Runner kendi peer listesini cikarsaydi rol YAML'i ile iki
 * kopya olur ve biri digerinden kayardi.
 */
/** CLI çalışma alanına eklenen dizinler — `roomLayout` ile aynı ortamdan. */
const includeDirs = geminiIncludeDirectories({
  contracts: process.env.ROOM_CONTRACTS ?? "/room/contracts",
  readable: (process.env.ROOM_READABLE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});

function roomLayout(): string {
  const peers = (process.env.ROOM_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const readable = (process.env.ROOM_READABLE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return roomLayoutNote({
    agent: agent.name,
    peers,
    workspace: process.cwd(),
    contracts: process.env.ROOM_CONTRACTS ?? "/room/contracts",
    readable,
  });
}

const markDirtyFrom = (event: NewRoomEvent, messageId: string): void => {
  if (event.type === "tool.result" || event.type === "tool.call") {
    diff.markDirty(messageId);
    /*
     * Gemini CLI tool GIRDISININ yolunu vermiyor (yalnizca `status`), bu
     * yuzden Claude yolundaki "yolu bilinen aracta dogrudan bak" kisayolu
     * burada yok: her tool cagrisindan sonra tam tarama. Tarama ucuz —
     * icerik yalnizca damga degisen dosyalar icin okunuyor.
     */
    void contracts.scan(messageId).catch(() => undefined);
  }
};

function runTurn(messageId: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    const resuming = geminiSessionId !== null;
    const newId = geminiSessionId ?? randomUUID();

    const args = [
      "--skip-trust", // headless: etkileşimli güven onayı yok
      "-o",
      "stream-json",
      // Düzenleme tool'ları sorulmadan geçsin; kısıt --allowed-tools'tan gelir.
      "--approval-mode",
      "auto_edit",
      ...(resuming ? ["--resume", newId] : ["--session-id", newId]),
      // Bayrağı TEKRARLA, dizi olarak verme: `--allowed-tools a b c -p "x"`
      // biçiminde yargs dizinin sonunu bulamayıp prompt'u pozisyonel argümana
      // çeviriyor ve "Cannot use both a positional prompt and --prompt" diyor.
      ...tools.allow.flatMap((t) => ["--allowed-tools", t]),
      // contracts/ ve readable klasorleri CLI'in calisma alanina: yoksa araclar
      // "Path not in workspace" diyor. Yetki degil — yetki Unix kullanicisinda.
      ...includeDirs.flatMap((d) => ["--include-directories", d]),
      /**
       * `AGENT_MODEL` YAML'ı EZER — Claude runner'ı da böyle davranıyor
       * (`model: process.env.AGENT_MODEL`). Burada sadece `agent.model`'e
       * bakılıyordu, yani ortam değişkeni Gemini tarafında sessizce yok
       * sayılıyordu: kapı testleri "haiku ile koş" diyor, biz gemini'ye
       * söylemiyorduk.
       */
      ...(() => {
        const model = process.env.AGENT_MODEL || agent.model;
        return model && model !== "auto" ? ["-m", model] : [];
      })(),
      "-p",
      text,
    ];

    const ctx = {
      roomId,
      sessionId,
      agent: agent.name,
      messageId,
      allowedTools,
    };

    let ok = false;
    let sawAnything = false;
    /**
     * `result` satırı geldi mi. Geldiyse turn BİR bitiş event'i üretti ve
     * ikincisini yazmak yasak: "her messageId için tam olarak bir bitiş
     * event'i" kuralı (validate-events bunu denetliyor).
     */
    let sawTerminal = false;
    /**
     * Gemini'nin son stderr satırları. Turn hata ile bitince SEBEP burada
     * yazıyor (kota 429, 503, geçersiz anahtar) ve `turn.failed` event'inin
     * `error` alanına giriyor — sunucu logunda kalması yetmiyor, ekranda
     * neden bittiği görünmüyordu.
     */
    let stderrTail = "";
    const STDERR_TAIL_MAX = 800;
    /** Gemini asistan metnini `delta:true` parçalarıyla yolluyor; birleştir. */
    let textParts: string[] = [];
    /**
     * Başarısız sağlayıcı istekleri (503/429). Her biri ekranda bir
     * `turn.retrying`; bütçe dolunca süreç durdurulur çünkü her deneme
     * kotadan düşüyor ve CLI kendi başına durmuyor (map-stream.ts).
     */
    const retries = createRetryTracker(RETRY_BUDGET);
    let retryExhausted: RetrySignal | null = null;
    let lastRetry: RetrySignal | null = null;
    /**
     * `turn.started` yazıldı mı. Deneme event'i ondan ÖNCE yazılamaz
     * (validate-events: message.received'ı turn.started izler). Ölçümde
     * init satırı hep ilk isteğin önünde geldi; yine de sıra garanti değil.
     */
    let started = false;
    const pendingRetries: RetrySignal[] = [];
    const emitRetry = (s: RetrySignal): void => {
      emit({
        ...envelope,
        actor: agentActor,
        type: "turn.retrying",
        payload: {
          ...turnRef(messageId),
          provider: "Google",
          attempt: s.attempt,
          budget: s.budget,
          status: s.status,
          detail: s.detail,
        },
      } as NewRoomEvent);
    };

    /**
     * `detached: true` — süreç KENDİ grubunda başlar.
     *
     * Neden: kesme ölçüldü ve 32 saniye sürdü. Sebebi şu: Gemini CLI'ya
     * SIGTERM göndermek onun başlattığı `sleep 120` çocuğunu durdurmuyor;
     * turn kapanmıyor ve host 30 saniye sonra runner'ı sert kesiyordu
     * (`mode: hard_kill`). Kendi grubunda başlayan sürece sinyali GRUBA
     * göndererek (`kill(-pid)`) çocuk kabuk komutu da durur.
     *
     * Grup her yolda öldürülüyor (kesme, shutdown, çıkış), yani sahipsiz
     * süreç kalmıyor.
     */
    child = spawn(geminiBin, args, {
      cwd: process.cwd(),
      env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    /** Biriken metin parçalarını TEK `agent.text` olarak yaz. */
    const flushText = (): void => {
      if (textParts.length === 0) return;
      const text = textParts.join("");
      textParts = [];
      if (text.trim().length === 0) return;
      for (const e of mapStreamLine({ type: "message", role: "assistant", content: text }, ctx)
        .events) {
        emit(e);
      }
    };

    /**
     * `finish` İKİ KEZ çağrılabilir: `error` olayından sonra `close` da gelir.
     * Bitiş artık asenkron (diff yayımı + turn checkpoint'i) olduğu için
     * pencere genişledi; çift `turn_end` host'ta sıradaki mesajı erken
     * başlatırdı.
     */
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      flushText();
      // Bitiş event'i zaten yazıldıysa ikincisini YAZMA.
      // Süreç turn.started'dan önce öldüyse bekleyen denemeler yazılamaz:
      // sıra kuralı bozulurdu. Sebep yine de turn.failed metninde.
      if (!ok && !sawTerminal) {
        /*
         * Sebep sırası: kullanıcı kestiyse "interrupted" (bütçe o sırada
         * dolmuş olsa bile — durduran insandı); runner bütçe yüzünden
         * durdurduysa "retry_exhausted" ve metin stack trace değil cümle.
         */
        const exhausted = !interrupting ? retryExhausted : null;
        const status = exhausted?.status ? ` (${exhausted.status})` : "";
        emit({
          ...envelope,
          actor: agentActor,
          type: "turn.failed",
          payload: {
            ...turnRef(messageId),
            // Kesildiyse sebep "interrupted": kullanıcı durdurdu, süreç
            // kendi kendine ölmedi.
            reason: interrupting
              ? "interrupted"
              : exhausted
                ? "retry_exhausted"
                : sawAnything
                  ? "sdk_error"
                  : "crash",
            // Sebebi taşı: "tamamlamadan çıktı" tek başına hiçbir şey anlatmıyor.
            error: exhausted
              ? `Google yanıt vermedi${status}: ` +
                (exhausted.attempt >= exhausted.budget
                  ? `art arda ${exhausted.attempt} deneme başarısız`
                  : `bu turn'de toplam ${exhausted.total} deneme başarısız`) +
                `, runner durdurdu (her deneme kotadan düşer). ${exhausted.detail}`.trim()
              : ["gemini süreci turn'ü tamamlamadan çıktı", lastRetry?.detail ?? "", stderrTail.trim()]
                  .filter((s) => s.length > 0)
                  .join(" · ")
                  .slice(0, 2000),
          },
        } as NewRoomEvent);
      }
      /**
       * Kesme GERÇEKTEN uygulandı. İstek ile uygulama arası sıfır değil —
       * uzun bir kabuk komutu bitmeden süreç kapanmıyor. `mode: "abort"`:
       * Gemini CLI'da kibar bir "interrupt" yolu yok, süreç sinyalle
       * durduruluyor (README "Karar notları").
       */
      if (interrupting) {
        emit({
          ...envelope,
          actor: agentActor,
          type: "interrupt.applied",
          payload: { ...turnRef(messageId), mode: "abort" },
        } as NewRoomEvent);
        interrupting = false;
      }

      /**
       * Turn bitti: son bir diff yayımı ZORLA yapılır, ardından turn
       * checkpoint'i alınır — Claude runner'la aynı sıra. `turn_end` en sona
       * kalır: host onu görünce agent'ı idle'a alıyor ve sıradaki mesajı
       * veriyor, yani ondan sonra yazılan bir `diff.updated` yanlış turn'e
       * yapışırdı.
       */
      void (async () => {
        if (diff.enabled) {
          await diff.flush(messageId).catch(() => undefined);
          await diff
            .checkpoint("turn", `turn sonu: ${messageId.slice(0, 8)}`, messageId)
            .catch((err: unknown) =>
              out({
                kind: "log",
                level: "warn",
                msg: `turn checkpoint'i alınamadı: ${String(err)}`,
              }),
            );
        }
        await contracts.scan(messageId).catch(() => undefined);
        await reportIsolationDrift();
        out({ kind: "turn_end", messageId, sdkSessionId: geminiSessionId, ok });
        child = null;
        resolve();
      })();
    };

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (raw) => {
      const line = raw.trim();
      if (line.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Gemini stdout'u temiz JSON veriyor; yine de bir şey kaçarsa
        // event log'a DEĞİL, sunucu loguna gitsin.
        out({ kind: "log", level: "warn", msg: `gemini stdout ayrıştırılamadı: ${line.slice(0, 200)}` });
        return;
      }
      sawAnything = true;

      // Asistan metni parça parça geliyor: biriktir, başka bir satır
      // gelince tek event olarak yaz. Yoksa akışta cümleler ortadan bölünür.
      const rec = parsed as { type?: string; role?: string; content?: unknown };
      // Model bir şey üretti → sağlayıcı cevap veriyor, art arda deneme sayacı
      // sıfırlanır. `tool_result` sayılmaz: onu CLI yerelde üretiyor.
      if ((rec.type === "message" && rec.role === "assistant") || rec.type === "tool_use") {
        retries.success();
      }
      if (rec.type === "message" && rec.role === "assistant") {
        textParts.push(typeof rec.content === "string" ? rec.content : "");
        return;
      }
      flushText();

      const mapped = mapStreamLine(parsed, { ...ctx, errorTail: stderrTail });
      if (mapped.sdkSessionId) geminiSessionId = mapped.sdkSessionId;
      for (const event of mapped.events) {
        emit(event);
        markDirtyFrom(event, messageId);
        if (event.type === "turn.started" && !started) {
          started = true;
          for (const s of pendingRetries.splice(0)) emitRetry(s);
        }
      }
      if (mapped.finished) {
        ok = mapped.finished.ok;
        sawTerminal = true;
      }
    });

    // Gemini'nin stderr'i KENDİ stderr'imize akar, protokol kanalına DEĞİL.
    //
    // Önceki hâli her stderr satırını bir `log` mesajına çevirip stdout'a
    // yazıyordu. Gemini bir 503 aldığında onlarca satır stack trace döküyor;
    // heartbeat'ler o selin arkasına sıraya giriyor, 20 sn'yi aşıyor ve host
    // runner'ı ölmüş sanıp öldürüyordu. Dış dünyanın sınırsız çıktısı protokol
    // kanalına sokulmaz — exec katmanı stderr'i zaten sunucu loguna taşıyor.
    child.stderr!.on("data", (chunk: Buffer) => {
      // Kendi stderr'imize aynen akar (sunucu logu onu redaction'dan geçirir).
      process.stderr.write(chunk);
      // Son N karakteri sakla: hata sebebi genelde en sondadır.
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX);

      // Başarısız istekler: sayı sınırlı (bütçe), protokol kanalını sel basmaz.
      for (const s of retries.feed(chunk.toString("utf8"))) {
        if (retryExhausted) break;
        lastRetry = s;
        if (started) emitRetry(s);
        else pendingRetries.push(s);
        if (s.exhausted && child) {
          retryExhausted = s;
          const target = child;
          killTree(target, "SIGTERM");
          setTimeout(() => {
            if (target.exitCode === null && target.signalCode === null) killTree(target, "SIGKILL");
          }, SIGKILL_AFTER_MS).unref?.();
        }
      }
    });

    child.on("error", (err) => {
      out({ kind: "log", level: "error", msg: `gemini başlatılamadı: ${String(err)}` });
      finish();
    });
    child.on("close", () => {
      rl.close();
      finish();
    });
  });
}

const turnRef = (messageId: string): { agent: string; messageId: string } => ({
  agent: agent.name,
  messageId,
});

/**
 * Rol bağlamını çalışma alanına yaz. ÜZERİNE YAZAR: tek kaynak rol YAML'ı,
 * dosyanın elle düzenlenmiş hâli değil.
 *
 * Yazamamak turn'ü engellemez — rol bağlamı olmadan da agent çalışır, sadece
 * rolünü bilmez. Sessizce geçmek yerine söylenir.
 */
/**
 * Ortamda ne olduğunu ÖLÇ. Elle yazılmış bir liste imajla kayar; `node -v`
 * kayamaz. Ölçüm yerel ve tek seferlik (agent başlangıcı), turn'e maliyeti yok.
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

const writeContextFile = (): void => {
  const target = path.join(process.cwd(), "GEMINI.md");
  try {
    writeFileSync(target, geminiContextFile(agent, probeToolchain(), roomLayout()), "utf8");
    out({ kind: "log", level: "info", msg: `rol baglami yazildi: ${target}` });
  } catch (err) {
    out({
      kind: "log",
      level: "warn",
      msg: `rol baglami yazilamadi (${target}): ${String(err)} — agent rolunu bilmeyecek`,
    });
  }
};

writeContextFile();

out({ kind: "ready", pid: process.pid, protocolVersion: PROTOCOL_VERSION });
setInterval(() => out({ kind: "heartbeat", busy }), 5_000);

const shutdown = (): void => {
  if (child) killTree(child, "SIGTERM");
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
   * Taban degisti (sunucu manuel checkpoint aldi). Artimli harita sifirlanir
   * ve yeni tabana gore TAM diff yayimlanir.
   */
  if (cmd.kind === "set_base") {
    void diff
      .setBase({ checkpointId: cmd.checkpointId, treeSha: cmd.treeSha })
      .catch((err: unknown) =>
        out({ kind: "log", level: "warn", msg: `taban degistirilemedi: ${String(err)}` }),
      );
    return;
  }

  /**
   * Kesme. Yetki host tarafında (yalnızca sürücü); burada tek kontrol "hangi
   * turn": geç kalmış bir kesme komutu bir sonraki mesajı öldürmesin.
   */
  if (cmd.kind === "interrupt") {
    if (!busy || cmd.messageId !== currentMessageId || !child) {
      out({ kind: "log", level: "warn", msg: `kesilecek turn yok: ${cmd.messageId}` });
      return;
    }
    interrupting = true;
    const target = child;
    killTree(target, "SIGTERM");
    // Kibar sinyale cevap vermezse sert dur: "kesildi" demek ve durmamak
    // kullanıcıya yalan söylemek olur.
    setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null) killTree(target, "SIGKILL");
    }, SIGKILL_AFTER_MS).unref?.();
    return;
  }

  if (busy) {
    out({ kind: "log", level: "warn", msg: `meşgul, reddedildi: ${cmd.messageId}` });
    return;
  }

  busy = true;
  currentMessageId = cmd.messageId;
  void runTurn(cmd.messageId, cmd.text).finally(() => {
    busy = false;
    currentMessageId = null;
    interrupting = false;
  });
});

rl.on("close", shutdown);
