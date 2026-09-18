import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TurnView } from "@agent-rooms/view";
import { SHELL_TOOLS } from "../model/format-tool.js";

/**
 * Ham terminal — ekran malzemesi.
 *
 * TERMİNAL BİR GÖRÜNÜMDÜR, KAYNAK DEĞİLDİR. Buraya yazılan her şey event
 * log'dan türetilir; log'da olmayan bir şey burada görünüyorsa bug'dır.
 * Salt okunur: komut yazma yolu yok.
 *
 * Sadece kabuk komutları düşer (`Bash`, `run_shell_command`); diğer tool'lar
 * etkinlik akışının işi.
 */

const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const OFF = `${ESC}[0m`;

interface Line {
  key: string;
  text: string;
}

/** Turn listesinden terminale yazılacak satırları türet — saf. */
function renderLines(turns: TurnView[]): Line[] {
  const out: Line[] = [];
  for (const turn of turns) {
    const short = turn.messageId.slice(0, 8);
    out.push({ key: `sep-${turn.messageId}`, text: `\r\n${DIM}── ${short} ──${OFF}\r\n` });
    for (const item of turn.items) {
      if (item.kind !== "tool" || !SHELL_TOOLS.has(item.tool)) continue;
      const input = (item.input ?? {}) as { command?: unknown };
      const command = typeof input.command === "string" ? input.command : "";
      out.push({ key: `cmd-${item.seq}`, text: `${DIM}$${OFF} ${command}\r\n` });
      if (item.result) {
        const mark = item.result.isError ? `${RED}!${OFF} ` : "";
        // Ham çıktı: ANSI renkleri BOZULMADAN geçer.
        out.push({ key: `out-${item.seq}`, text: `${mark}${item.result.output}\r\n\r\n` });
      }
    }
  }
  return out;
}

export function TerminalView({ turns, visible }: { turns: TurnView[]; visible: boolean }) {
  const host = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const written = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!host.current || term.current) return;
    const t = new Terminal({
      scrollback: 5000,
      convertEol: true,
      fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace",
      fontSize: 12,
      // Klavye girişi alınmaz: kaynak event log.
      disableStdin: true,
      theme: { background: "#14171a", foreground: "#d7dbd9" },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current);
    f.fit();
    term.current = t;
    fit.current = f;

    const onResize = (): void => {
      try {
        f.fit();
      } catch {
        /* panel gizliyken ölçüm başarısız olabilir */
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!term.current) return;
    for (const line of renderLines(turns)) {
      if (written.current.has(line.key)) continue;
      written.current.add(line.key);
      queue.current.push(line.text);
    }
    if (queue.current.length === 0 || frame.current !== null) return;

    // Batch yazım: event başına `write` çağırmak tarayıcıyı boğar.
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const chunk = queue.current.join("");
      queue.current = [];
      term.current?.write(chunk);
    });
  }, [turns]);

  // Sekme değişince unmount ETME: geçmiş kaybolur. Gizle ve dönüşte ölç.
  useEffect(() => {
    if (visible) setTimeout(() => fit.current?.fit(), 0);
  }, [visible]);

  return (
    <div
      style={{
        display: visible ? "block" : "none",
        background: "var(--screen)",
        padding: 8,
        height: "100%",
      }}
    >
      <div ref={host} style={{ height: "100%" }} />
    </div>
  );
}
