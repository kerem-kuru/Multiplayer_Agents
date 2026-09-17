import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { AgentConfig, PROTOCOL_VERSION, RunnerCommand, RunnerOutput } from "@agent-rooms/protocol";
import { mapStreamLine, resolveGeminiTools } from "./map-stream.js";

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

const out = (o: RunnerOutput): void => {
  process.stdout.write(JSON.stringify(RunnerOutput.parse(o)) + "\n");
};
const emit = (event: NewRoomEvent): void => out({ kind: "event", event });

const envelope = { roomId, sessionId };
const agentActor = { kind: "agent", name: agent.name } as const;

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
      ...(agent.model && agent.model !== "auto" ? ["-m", agent.model] : []),
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
    /** Gemini asistan metnini `delta:true` parçalarıyla yolluyor; birleştir. */
    let textParts: string[] = [];

    child = spawn(geminiBin, args, {
      cwd: process.cwd(),
      env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
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

    const finish = (): void => {
      flushText();
      // Bitiş event'i zaten yazıldıysa ikincisini YAZMA.
      if (!ok && !sawTerminal) {
        emit({
          ...envelope,
          actor: agentActor,
          type: "turn.failed",
          payload: {
            ...turnRef(messageId),
            reason: sawAnything ? "sdk_error" : "crash",
            error: "gemini süreci turn'ü tamamlamadan çıktı",
          },
        } as NewRoomEvent);
      }
      out({ kind: "turn_end", messageId, sdkSessionId: geminiSessionId, ok });
      child = null;
      resolve();
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
      if (rec.type === "message" && rec.role === "assistant") {
        textParts.push(typeof rec.content === "string" ? rec.content : "");
        return;
      }
      flushText();

      const mapped = mapStreamLine(parsed, ctx);
      if (mapped.sdkSessionId) geminiSessionId = mapped.sdkSessionId;
      for (const event of mapped.events) emit(event);
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
    child.stderr!.pipe(process.stderr);

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

out({ kind: "ready", pid: process.pid, protocolVersion: PROTOCOL_VERSION });
setInterval(() => out({ kind: "heartbeat", busy }), 5_000);

const shutdown = (): void => {
  child?.kill("SIGTERM");
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
    shutdown();
    return;
  }
  if (busy) {
    out({ kind: "log", level: "warn", msg: `meşgul, reddedildi: ${cmd.messageId}` });
    return;
  }

  busy = true;
  void runTurn(cmd.messageId, cmd.text).finally(() => {
    busy = false;
  });
});

rl.on("close", shutdown);
