import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RoomConfig } from "@agent-rooms/protocol";

/**
 * Oda defteri — Hafta 1 iskeleti.
 *
 * Bugün defter diskteki bir klasör; içine henüz kimse yazmıyor. Hafta 8'de
 * `journal` tablosu + Zod şeması gelecek (`status`, `touched`, `decisions`,
 * `contracts`, `blocked_on`, `needs_from`, `version`) ve bu fonksiyon
 * `superseded_by` ile en güncel kaydı döndüren bir projeksiyona dönüşecek.
 *
 * Endpoint'in bugün var olmasının sebebi: istemci sözleşmesi Hafta 3'te
 * yazılacak ve o zaman şeklinin belli olması lazım.
 */

export interface JournalEntry {
  file: string;
  /** Dosya adından çıkarılan agent adı. Eşleşmezse null. */
  agent: string | null;
  bytes: number;
  updatedAt: string;
}

export interface JournalView {
  entries: JournalEntry[];
  /** Defterin nereden okunduğu. Hafta 8'de "postgres" olacak; istemci bunu bilsin. */
  source: "filesystem-stub";
}

export async function readJournal(roomRoot: string, config: RoomConfig): Promise<JournalView> {
  const dir = path.join(roomRoot, config.journalDir);
  const names = new Set(config.agents.map((a) => a.name));

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return { entries: [], source: "filesystem-stub" };
  }

  const entries: JournalEntry[] = [];
  for (const file of files) {
    if (file.startsWith(".")) continue;
    const info = await stat(path.join(dir, file));
    if (!info.isFile()) continue;
    const stem = file.replace(/\.[^.]+$/, "");
    entries.push({
      file,
      agent: names.has(stem) ? stem : null,
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
    });
  }

  entries.sort((a, b) => a.file.localeCompare(b.file));
  return { entries, source: "filesystem-stub" };
}
