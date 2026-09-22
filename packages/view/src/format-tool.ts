import { roomRelativePath } from "@agent-rooms/protocol";

/**
 * Tool çağrısı → TEK SATIR özet.
 *
 * Amaç: 40 satırlık bir girdiyi listede göstermek yerine ne yapıldığını bir
 * bakışta okutmak. Ayrıntı tıklayınca açılır.
 *
 * İki koşum ortamının tool adları farklı (Claude: `Bash`, Gemini:
 * `run_shell_command`); ikisi de burada karşılanır.
 */

const first = (s: string, n = 120): string => {
  const line = s.split("\n")[0] ?? "";
  return line.length > n ? `${line.slice(0, n)}…` : line;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Yollar ekranda oda-göreli görünür. Tool girdisi mutlak yol taşıyor
 * (`/room/worktrees/backend/hello.js`); `file.changed` zaten normalleştiriliyor,
 * özet satırı da aynı biçimi vermeli.
 */
const short = (v: unknown): string => roomRelativePath(str(v));

export function formatTool(tool: string, input: unknown): string {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  switch (tool) {
    // --- Claude ---
    case "Bash":
      return first(str(i.command));
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return short(i.file_path) || short(i.notebook_path) || "—";
    case "Glob":
      return str(i.pattern) || "—";
    case "Grep":
      return `${str(i.pattern)}${i.path ? ` · ${short(i.path)}` : ""}` || "—";

    // --- Gemini ---
    case "run_shell_command":
      return first(str(i.command));
    case "write_file":
    case "read_file":
    case "replace":
      return short(i.file_path) || short(i.path) || "—";
    case "list_directory":
      return short(i.path) || short(i.dir) || "—";
    case "grep":
      return str(i.pattern) || str(i.query) || "—";

    default: {
      const keys = Object.keys(i);
      return keys.length > 0 ? keys.join(", ") : "—";
    }
  }
}

/** Kabuk komutu mu — terminale SADECE bunlar düşer, diğerleri akışın işi. */
export const SHELL_TOOLS = new Set(["Bash", "run_shell_command"]);

/**
 * Etkinlik akışı düz metindir: ANSI kaçışları temizlenir.
 * Terminale giden yolda KULLANILMAZ — orada renkler bozulmadan kalmalı.
 */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export const stripAnsi = (s: string): string => s.replace(ANSI, "");
