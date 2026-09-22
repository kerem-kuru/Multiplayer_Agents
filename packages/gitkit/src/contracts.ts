import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { NewRoomEvent } from "@agent-rooms/protocol";

/**
 * Hafta 7, Adım 7 — `contracts/` takibi.
 *
 * **Neden Hafta 6'nın canlı diff'i yetmiyor:** `contracts/` agent'ın `cwd`'si
 * DIŞINDA (`/room/contracts`, agent ise `/room/worktrees/<ad>` içinde koşuyor).
 * Diff yayımcısı agent'ın kendi deposunu izliyor ve sözleşme klasörünü hiç
 * görmüyor. Ayrı, hafif bir takip gerekiyor.
 *
 * **İçerik event'e GİRMEZ** — yalnızca sha256 ve boyut. Sözleşme dosyaları
 * büyüyebilir; her değişiklikte tam içeriği log'a yazmak log'u şişirir ve
 * redaction'dan geçmesi gereken bir metni her yere kopyalar. İçeriği görmek
 * isteyen UI ayrı bir uçtan okur.
 *
 * İki tetikleyici:
 *   1. `PostToolUse` (Edit/Write/NotebookEdit) → yol `contracts/` altındaysa ANINDA
 *   2. `PostToolUse` (Bash) ve turn sonu → klasörü tara, değişenleri bul
 *
 * İkincisi gerekli: `sed -i`, `cat >` ve kod üreticiler sözleşmeyi tool
 * girdisinden okunamayacak şekilde değiştirir.
 */

export const CONTRACTS_ROOT = "/room/contracts";

/** Tarama parmak izi: içerik okumadan "değişmiş olabilir mi" sorusunu cevaplar. */
interface Stamp {
  size: number;
  mtimeMs: number;
}

export interface ContractsWatcherOptions {
  /** Sözleşme klasörü — testte geçici bir dizin verilir. */
  root?: string;
  roomId: string;
  sessionId: string;
  agent: string;
  emit: (event: NewRoomEvent) => void;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

export class ContractsWatcher {
  private readonly root: string;
  private readonly opts: ContractsWatcherOptions;
  /** Son taramada görülen dosyalar. Boş harita = henüz taranmadı. */
  private seen = new Map<string, Stamp>();
  /** Yayımlanmış hash'ler: aynı içerik iki kez event üretmesin. */
  private hashes = new Map<string, string>();
  /**
   * Taban kuruldu mu.
   *
   * Harita boyutundan CIKARILAMAZ: `contracts/` bos basliyor, yani ilk tarama
   * sonrasi da haritalar bos kalir ve "hala ilk tarama" sanilirdi. Sonuc: bos
   * klasore eklenen ILK sozlesme hic duyurulmazdi — uretimde en sik olacak
   * durum tam bu. (Birim test yakaladi.)
   */
  private baseline = false;
  private scanning = false;

  constructor(opts: ContractsWatcherOptions) {
    this.opts = opts;
    this.root = opts.root ?? CONTRACTS_ROOT;
  }

  /** Bir tool bilinen bir yola yazdıysa: yol contracts altındaysa hemen bak. */
  async onToolPath(filePath: string, messageId: string | null): Promise<void> {
    const abs = path.resolve(filePath);
    if (!this.isInside(abs)) return;
    await this.scan(messageId);
  }

  /** Bash ve turn sonu: tüm klasörü tara. */
  async scan(messageId: string | null): Promise<void> {
    // Aynı anda tek tarama: iki tarama iç içe girerse aynı değişiklik iki kez
    // yayımlanır ve `seen` haritası yarıda kalmış bir durumla güncellenir.
    if (this.scanning) return;
    this.scanning = true;
    try {
      const current = await this.walk();
      const first = !this.baseline;

      for (const [rel, stamp] of current) {
        const before = this.seen.get(rel);
        if (before && before.size === stamp.size && before.mtimeMs === stamp.mtimeMs) continue;

        const hash = await this.hashOf(rel);
        if (hash === null) continue;
        // İlk tarama TABANI kurar: agent başlamadan önce orada olan dosyalar
        // "agent değiştirdi" diye yayımlanmamalı.
        if (!first && this.hashes.get(rel) !== hash) {
          this.emitChange(rel, hash, stamp.size, false, messageId);
        }
        this.hashes.set(rel, hash);
      }

      for (const [rel] of this.seen) {
        if (current.has(rel)) continue;
        if (!first) this.emitChange(rel, "", 0, true, messageId);
        this.hashes.delete(rel);
      }

      this.seen = current;
      this.baseline = true;
    } catch (err) {
      this.opts.log?.("warn", `contracts taraması düştü: ${String(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  private emitChange(
    rel: string,
    sha256: string,
    size: number,
    deleted: boolean,
    messageId: string | null,
  ): void {
    this.opts.emit({
      roomId: this.opts.roomId,
      sessionId: this.opts.sessionId,
      actor: { kind: "agent", name: this.opts.agent },
      type: "contract.changed",
      payload: {
        agent: this.opts.agent,
        messageId,
        path: rel,
        sha256,
        size,
        deleted,
      },
    } as NewRoomEvent);
  }

  private isInside(abs: string): boolean {
    const root = path.resolve(this.root);
    return abs === root || abs.startsWith(root + path.sep) || abs.startsWith(root + "/");
  }

  private async hashOf(rel: string): Promise<string | null> {
    try {
      const buf = await readFile(path.join(this.root, rel));
      return createHash("sha256").update(buf).digest("hex");
    } catch {
      return null;
    }
  }

  /** `contracts/` altındaki dosyalar — göreli yol → damga. */
  private async walk(): Promise<Map<string, Stamp>> {
    const out = new Map<string, Stamp>();
    const visit = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        // Nokta dosyaları atlanıyor: `.git` ya da editör geçici dosyaları
        // sözleşme değil.
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await visit(abs, rel);
          continue;
        }
        if (!e.isFile()) continue;
        try {
          const s = await stat(abs);
          out.set(rel, { size: s.size, mtimeMs: s.mtimeMs });
        } catch {
          // Tarama sırasında silinmiş olabilir.
        }
      }
    };
    await visit(this.root, "");
    return out;
  }
}
