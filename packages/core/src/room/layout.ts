import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoomConfig } from "@agent-rooms/protocol";
import { roomLayout } from "@agent-rooms/protocol";

/**
 * Oda kökünün klasör düzeni:
 *
 *   /room
 *   ├── worktrees/<agent>/   her agent kendi branch'i, tam yetki
 *   ├── contracts/           herkese yazılabilir — API sözleşmeleri
 *   └── journal/             oda defteri
 *
 * Bu fonksiyon sadece iskeleti kurar. `git worktree` bağlama Hafta 7'de gelir;
 * o zamana kadar klasörler boş durur ve mount izinleri burada test edilir.
 */
export async function scaffoldRoomLayout(roomRoot: string, config: RoomConfig): Promise<string[]> {
  const dirs = roomLayout(config).map((d) => path.join(roomRoot, d));
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(
    path.join(roomRoot, config.contractsDir, "README.md"),
    [
      "# contracts/",
      "",
      "Odadaki tek ortak yazılabilir alan. Agent'lar birbirine mesaj atmaz;",
      "API sözleşmeleri burada anlaşılır. Buraya yazılan her dosya",
      "diğer agent'ların turn başı bağlamına girer.",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(roomRoot, config.journalDir, ".gitkeep"),
    "",
    "utf8",
  );

  return dirs;
}

/** Container içinde her agent'ın göreceği mount planı: kendi worktree'si rw, gerisi ro. */
export interface MountPlan {
  agent: string;
  readWrite: string[];
  readOnly: string[];
}

export function mountPlan(config: RoomConfig): MountPlan[] {
  const all = roomLayout(config);
  return config.agents.map((agent) => {
    const rw = agent.writable.length > 0 ? agent.writable : [agent.workspace, config.contractsDir];
    return {
      agent: agent.name,
      readWrite: rw,
      readOnly: all.filter((d) => !rw.some((w) => d === w || d.startsWith(`${w}/`))),
    };
  });
}
