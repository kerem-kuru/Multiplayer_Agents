import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { DiffPublisher, createCheckpoint, initWorkspace, newCheckpointId } from "../src/index.js";

/**
 * Yayımcı testleri — gerçek git, sahte emit.
 *
 * Ölçülen şey model çıktısı değil SIRA ve ARTIMLILIK: aynı dosya iki kez
 * gönderiliyor mu, taban değişince harita sıfırlanıyor mu, turn sonunda
 * checkpoint gerçekten alınıyor mu.
 */

const ROOM = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const MID = "33333333-3333-4333-8333-333333333333";

let dir: string;
let events: NewRoomEvent[];
let pub: DiffPublisher;

const write = async (rel: string, body: string): Promise<void> => {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
};

const diffs = (): Array<{ files: Array<{ path: string; status: string }> }> =>
  events
    .filter((e) => e.type === "diff.updated")
    .map((e) => e.payload as { files: Array<{ path: string; status: string }> });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitkit-pub-"));
  await write("src/order.js", "function processOrder(o) {\n  return o;\n}\n");
  await write("package.json", '{\n  "version": "0.1.0"\n}\n');
  const init = await initWorkspace(dir);
  events = [];
  pub = new DiffPublisher({
    cwd: dir,
    agent: "backend",
    roomId: ROOM,
    sessionId: SESSION,
    emit: (e) => events.push(e),
    base: { checkpointId: init.checkpointId, treeSha: init.treeSha },
    debounceMs: 5,
  });
});

afterEach(async () => {
  pub.stop();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("DiffPublisher", () => {
  it("değişiklik yoksa event yazmaz", async () => {
    await pub.flush(MID);
    expect(diffs()).toHaveLength(0);
  });

  it("değişen dosyayı yayımlar, ikinci yayımda tekrar göndermez", async () => {
    await write("src/order.js", "// bir\nfunction processOrder(o) {\n  return o;\n}\n");
    await pub.flush(MID);

    expect(diffs()).toHaveLength(1);
    expect(diffs()[0]?.files.map((f) => f.path)).toEqual(["src/order.js"]);

    // Hiçbir şey değişmedi: ikinci yayım event üretmemeli.
    await pub.flush(MID);
    expect(diffs()).toHaveLength(1);

    // Başka dosya değişti: event SADECE onu taşımalı.
    await write("package.json", '{\n  "version": "0.2.0"\n}\n');
    await pub.flush(MID);
    expect(diffs()).toHaveLength(2);
    expect(diffs()[1]?.files.map((f) => f.path)).toEqual(["package.json"]);
  });

  it("tabana geri dönen dosya clean olarak bildirilir", async () => {
    const original = "function processOrder(o) {\n  return o;\n}\n";
    await write("src/order.js", "// bir\n" + original);
    await pub.flush(MID);
    await write("src/order.js", original);
    await pub.flush(MID);

    const last = diffs()[1];
    expect(last?.files).toEqual([expect.objectContaining({ path: "src/order.js", status: "clean" })]);
  });

  it("markDirty debounce'lu yayım tetikler", async () => {
    await write("src/order.js", "// iki\nfunction processOrder(o) {\n  return o;\n}\n");
    pub.markDirty(MID);
    expect(diffs()).toHaveLength(0); // hemen değil

    await new Promise((r) => setTimeout(r, 400));
    expect(diffs()).toHaveLength(1);
  });

  it("set_base haritayı sıfırlar ve yeni tabana göre TAM diff yayımlar", async () => {
    await write("src/order.js", "// üç\nfunction processOrder(o) {\n  return o;\n}\n");
    await pub.flush(MID);
    expect(diffs()).toHaveLength(1);

    // Yeni taban = şu anki hâl. Yeni tabana göre hiçbir şey değişmemiş,
    // ama eski harita temizlendiği için dosya "clean" olarak bildirilir.
    const cp = await createCheckpoint(dir, newCheckpointId(), "elle");
    await pub.setBase({ checkpointId: cp.checkpointId, treeSha: cp.treeSha });
    expect(pub.baseCheckpointId).toBe(cp.checkpointId);

    // Yeni tabandan sonra bir değişiklik: SADECE o gitmeli.
    await write("package.json", '{\n  "version": "0.3.0"\n}\n');
    await pub.flush(MID);
    const last = diffs()[diffs().length - 1];
    expect(last?.files.map((f) => f.path)).toEqual(["package.json"]);
  });

  it("turn checkpoint'i taban OLMAZ, baseline ve manuel olur", async () => {
    await pub.checkpoint("turn", "turn sonu", MID);
    await pub.checkpoint("manual", "öğle arası", null);

    const cps = events
      .filter((e) => e.type === "checkpoint.created")
      .map((e) => e.payload as { kind: string; becomesBase: boolean; messageId: string | null });

    expect(cps[0]).toMatchObject({ kind: "turn", becomesBase: false, messageId: MID });
    expect(cps[1]).toMatchObject({ kind: "manual", becomesBase: true, messageId: null });
  });

  it("taban yoksa hiçbir şey yayımlamaz", async () => {
    const sessiz = new DiffPublisher({
      cwd: dir,
      agent: "backend",
      roomId: ROOM,
      sessionId: SESSION,
      emit: (e) => events.push(e),
      base: null,
    });
    await write("src/order.js", "// dört\n");
    await sessiz.flush(MID);
    sessiz.stop();

    expect(sessiz.enabled).toBe(false);
    expect(diffs()).toHaveLength(0);
  });

  it("node_modules yayımlanmaz", async () => {
    await write("node_modules/x/index.js", "module.exports = 1\n");
    await pub.flush(MID);
    expect(diffs()).toHaveLength(0);
  });
});
