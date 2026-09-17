import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import {
  AgentConfig,
  PROTOCOL_VERSION,
  RunnerCommand,
  RunnerOutput,
  resolveSdkTools,
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

let sdkSessionId: string | null = process.env.RESUME_SESSION_ID || null;
let busy = false;
let abort: AbortController | null = null;

const out = (o: RunnerOutput): void => {
  process.stdout.write(JSON.stringify(RunnerOutput.parse(o)) + "\n");
};
const emit = (event: NewRoomEvent): void => out({ kind: "event", event });

const agentActor = { kind: "agent", name: agent.name } as const;
const envelope = { roomId, sessionId };

async function runTurn(messageId: string, text: string, ac: AbortController): Promise<void> {
  const ctx = { roomId, sessionId, agent: agent.name, messageId };
  const turn = { agent: agent.name, messageId };
  let ok = false;

  try {
    const q = query({
      prompt: text,
      options: {
        cwd: process.cwd(),
        model: process.env.AGENT_MODEL,
        resume: sdkSessionId ?? undefined,
        systemPrompt: { type: "preset", preset: "claude_code", append: agent.systemPrompt },
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
              matcher: "Edit|Write|NotebookEdit",
              hooks: [
                async (input) => {
                  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
                  const path = i.tool_input?.file_path ?? i.tool_input?.notebook_path;
                  if (typeof path === "string" && path.length > 0) {
                    emit({
                      ...envelope,
                      actor: agentActor,
                      type: "file.changed",
                      payload: { ...turn, path, tool: i.tool_name ?? "" },
                    } as NewRoomEvent);
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
      if (m.type === "result") ok = m.subtype === "success";
    }
  } catch (err) {
    emit({
      ...envelope,
      actor: agentActor,
      type: "turn.failed",
      payload: {
        ...turn,
        reason: ac.signal.aborted ? "aborted" : "sdk_error",
        error: String(err).slice(0, 2000),
      },
    } as NewRoomEvent);
    ok = false;
  } finally {
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
    shutdown();
    return;
  }

  // Kuyruk Hafta 5'te; bu hafta meşguldeyken gelen iş reddedilir.
  if (busy) {
    out({ kind: "log", level: "warn", msg: `meşgul, reddedildi: ${cmd.messageId}` });
    return;
  }

  busy = true;
  const ac = new AbortController();
  abort = ac;
  void runTurn(cmd.messageId, cmd.text, ac).finally(() => {
    busy = false;
    abort = null;
  });
});

// Host bağlantısı koptu: uçuştaki turn'ü iptal et ve çık ki container içinde
// sahipsiz runner kalmasın.
rl.on("close", shutdown);
