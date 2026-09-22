import { describe, expect, it } from "vitest";
import { SHELL_TOOLS, formatTool, stripAnsi } from "@agent-rooms/view";

/**
 * Tool özeti UI'ın en çok okunan satırı: listede her tool için TEK satır
 * görünür. Saf fonksiyon olduğu için testi de saf.
 */

const ESC = String.fromCharCode(27);

describe("formatTool — Claude tool adları", () => {
  it("Bash: komutun ilk satırını verir", () => {
    expect(formatTool("Bash", { command: "node hello.js\necho bitti" })).toBe("node hello.js");
  });

  it("Bash: 120 karakterden uzun satırı kırpar", () => {
    const long = "echo " + "a".repeat(200);
    const out = formatTool("Bash", { command: long });
    expect(out.length).toBe(121); // 120 karakter + kırpma işareti
    expect(out.endsWith("…")).toBe(true);
  });

  it("Read/Write/Edit: yolu oda-göreli gösterir", () => {
    expect(formatTool("Write", { file_path: "/room/worktrees/backend/hello.js" })).toBe(
      "worktrees/backend/hello.js",
    );
    expect(formatTool("Read", { file_path: "/room/contracts/api.md" })).toBe("contracts/api.md");
    expect(formatTool("Edit", { file_path: "/room/README.md" })).toBe("README.md");
  });

  it("NotebookEdit: notebook_path alanına da bakar", () => {
    expect(formatTool("NotebookEdit", { notebook_path: "/room/nb/deneme.ipynb" })).toBe(
      "nb/deneme.ipynb",
    );
  });

  it("Glob deseni, Grep deseni + yolu", () => {
    expect(formatTool("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(formatTool("Grep", { pattern: "TODO", path: "/room/worktrees/backend" })).toBe(
      "TODO · worktrees/backend",
    );
    expect(formatTool("Grep", { pattern: "TODO" })).toBe("TODO");
  });
});

describe("formatTool — Gemini tool adları", () => {
  it("run_shell_command Bash ile aynı biçimi verir", () => {
    expect(formatTool("run_shell_command", { command: "ls -la\nikinci satır" })).toBe("ls -la");
  });

  it("write_file / read_file / replace yolu kısaltır", () => {
    expect(formatTool("write_file", { file_path: "/room/worktrees/backend/a.txt" })).toBe(
      "worktrees/backend/a.txt",
    );
    expect(formatTool("read_file", { path: "/room/b.txt" })).toBe("b.txt");
    expect(formatTool("replace", { file_path: "/room/c.txt" })).toBe("c.txt");
  });

  it("list_directory ve grep", () => {
    expect(formatTool("list_directory", { path: "/room/worktrees" })).toBe("worktrees");
    expect(formatTool("grep", { query: "hata" })).toBe("hata");
  });
});

describe("formatTool — sınır durumları", () => {
  it("bilinmeyen tool: girdi anahtarlarını listeler", () => {
    expect(formatTool("Bilinmeyen", { alfa: 1, beta: 2 })).toBe("alfa, beta");
  });

  it("boş veya bozuk girdide çökmez, tire döner", () => {
    expect(formatTool("Bilinmeyen", {})).toBe("—");
    expect(formatTool("Bilinmeyen", null)).toBe("—");
    expect(formatTool("Read", {})).toBe("—");
    expect(formatTool("Bash", { command: 42 })).toBe("");
  });

  it("oda kökü dışındaki yol olduğu gibi kalır", () => {
    expect(formatTool("Read", { file_path: "/etc/hosts" })).toBe("/etc/hosts");
  });
});

describe("SHELL_TOOLS", () => {
  it("terminale sadece kabuk tool'ları düşer", () => {
    expect(SHELL_TOOLS.has("Bash")).toBe(true);
    expect(SHELL_TOOLS.has("run_shell_command")).toBe(true);
    expect(SHELL_TOOLS.has("Write")).toBe(false);
    expect(SHELL_TOOLS.has("Read")).toBe(false);
  });
});

describe("stripAnsi", () => {
  it("renk kodlarını atar, metni bırakır", () => {
    expect(stripAnsi(`${ESC}[31mhata${ESC}[0m`)).toBe("hata");
  });

  it("imleç ve ekran temizleme dizilerini de atar", () => {
    expect(stripAnsi(`${ESC}[2J${ESC}[H satır`)).toBe(" satır");
  });

  it("ANSI içermeyen metni değiştirmez", () => {
    expect(stripAnsi("düz metin · 120")).toBe("düz metin · 120");
  });
});
