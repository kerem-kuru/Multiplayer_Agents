import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FileDiff,
  currentTree,
  diffTrees,
  fingerprint,
  git,
  incremental,
  initWorkspace,
  isGeneratedPath,
  parseNumstat,
  parseRawZ,
  splitByBudget,
} from "../src/index.js";

/**
 * Diff testleri GERÇEK git ile. Sahte git ile yazılmış bir diff testi yalnızca
 * kendi ayrıştırıcımızı kendi sabit metnimize karşı sınar; git sürümleri
 * arasında değişen `-z` ve `-M` davranışını ölçmez.
 */

let dir: string;
let baseTree: string;

const write = async (rel: string, body: string): Promise<void> => {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
};

const now = async (): Promise<FileDiff[]> => diffTrees(dir, baseTree, await currentTree(dir));
const byPath = (files: FileDiff[], p: string): FileDiff | undefined =>
  files.find((f) => f.path === p);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitkit-diff-"));
  // Hafta 7: depoyu test kurar, gitkit degil.
  await git(dir, ["init", "-b", "main"]);
  await write("src/order.js", ["function processOrder(o) {", "  return o;", "}", ""].join("\n"));
  await write("package.json", '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n');
  const init = await initWorkspace(dir);
  baseTree = init.treeSha;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("diffTrees", () => {
  it("değişiklik yoksa boş liste", async () => {
    expect(await now()).toEqual([]);
  });

  it("değişen dosyayı modified olarak, patch ve sayılarla verir", async () => {
    await write("src/order.js", ["// açıklama", "function processOrder(o) {", "  return o;", "}", ""].join("\n"));

    const files = await now();
    const f = byPath(files, "src/order.js");

    expect(files).toHaveLength(1);
    expect(f?.status).toBe("modified");
    expect(f?.additions).toBeGreaterThanOrEqual(1);
    expect(f?.patch).toContain("+// açıklama");
    expect(f?.blobHash).toMatch(/^[0-9a-f]{40}$/);
    expect(f?.truncated).toBe(false);
  });

  it("yeni dosya added, silinen dosya deleted", async () => {
    await write("src/yeni.js", "export const x = 1\n");
    await fs.rm(path.join(dir, "package.json"));

    const files = await now();

    expect(byPath(files, "src/yeni.js")?.status).toBe("added");
    expect(byPath(files, "package.json")?.status).toBe("deleted");
    expect(byPath(files, "package.json")?.blobHash).toBeNull();
  });

  it("yeniden adlandırmayı renamed + oldPath olarak görür", async () => {
    await fs.rename(path.join(dir, "src/order.js"), path.join(dir, "src/siparis.js"));

    const files = await now();
    const f = byPath(files, "src/siparis.js");

    expect(f?.status).toBe("renamed");
    expect(f?.oldPath).toBe("src/order.js");
  });

  it("ikili dosya binary, patch yok", async () => {
    await fs.writeFile(path.join(dir, "logo.png"), Buffer.from([0, 1, 2, 0, 255, 254, 0, 7]));

    const f = byPath(await now(), "logo.png");

    expect(f?.status).toBe("binary");
    expect(f?.patch).toBeNull();
    expect(f?.collapsedByDefault).toBe(true);
  });

  it("32 KB'ı aşan patch kırpılır ve truncated olur", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `satir ${i}`).join("\n") + "\n";
    await write("buyuk.txt", big);

    const f = byPath(await now(), "buyuk.txt");

    expect(f?.truncated).toBe(true);
    expect(Buffer.byteLength(f?.patch ?? "", "utf8")).toBeLessThanOrEqual(32 * 1024);
    // Kırpma satır sınırında: yarım bir diff satırı istemcide ayrıştırılamaz.
    expect(f?.patch?.endsWith("\n")).toBe(true);
  });

  it("uzun patch ve lock dosyaları kapalı başlar", async () => {
    const long = Array.from({ length: 1200 }, (_, i) => `l${i}`).join("\n") + "\n";
    await write("uzun.txt", long);
    await write("package-lock.json", '{\n  "lockfileVersion": 3\n}\n');

    const files = await now();

    expect(byPath(files, "uzun.txt")?.collapsedByDefault).toBe(true);
    expect(byPath(files, "package-lock.json")?.collapsedByDefault).toBe(true);
    expect(byPath(files, "src/order.js")).toBeUndefined();
  });

  it("node_modules diff'e girmez", async () => {
    await write("node_modules/x/index.js", "module.exports = 1\n");
    expect(await now()).toEqual([]);
  });
});

describe("artımlı yayım", () => {
  it("değişmeyen dosya ikinci kez gönderilmez", async () => {
    await write("src/order.js", "// bir\nfunction processOrder(o) {\n  return o;\n}\n");
    const first = incremental(new Map(), await now());
    expect(first.changed.map((f) => f.path)).toEqual(["src/order.js"]);

    // Başka bir dosya değişti: order.js tekrar gitmemeli.
    await write("package.json", '{\n  "name": "fixture",\n  "version": "0.2.0"\n}\n');
    const second = incremental(first.next, await now());

    expect(second.changed.map((f) => f.path)).toEqual(["package.json"]);
  });

  it("tabana geri dönen dosya clean olarak bildirilir", async () => {
    const original = ["function processOrder(o) {", "  return o;", "}", ""].join("\n");
    await write("src/order.js", "// bir\n" + original);
    const first = incremental(new Map(), await now());
    expect(first.changed).toHaveLength(1);

    await write("src/order.js", original);
    const second = incremental(first.next, await now());

    expect(second.changed).toHaveLength(1);
    expect(second.changed[0]?.status).toBe("clean");
    expect(second.changed[0]?.path).toBe("src/order.js");
    expect(second.next.size).toBe(0);
  });

  it("parmak izi silinmiş dosyada da kararlı", async () => {
    await fs.rm(path.join(dir, "package.json"));
    const first = incremental(new Map(), await now());
    const second = incremental(first.next, await now());

    expect(first.changed).toHaveLength(1);
    expect(second.changed).toHaveLength(0);
  });
});

describe("saf yardımcılar", () => {
  it("parseRawZ yeniden adlandırmada iki yol okur", () => {
    const raw =
      ":100644 100644 aaaa bbbb M\0src/a.ts\0" + ":100644 100644 cccc dddd R100\0eski.ts\0yeni.ts\0";
    const entries = parseRawZ(raw);

    expect(entries).toEqual([
      { status: "M", path: "src/a.ts", oldPath: null, newBlob: "bbbb" },
      { status: "R100", path: "yeni.ts", oldPath: "eski.ts", newBlob: "dddd" },
    ]);
  });

  it("parseNumstat binary'yi tanır", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\0")).toEqual({
      additions: 3,
      deletions: 1,
      binary: false,
    });
    expect(parseNumstat("-\t-\tlogo.png\0").binary).toBe(true);
  });

  it("isGeneratedPath lock ve üretilmiş dosyaları yakalar", () => {
    expect(isGeneratedPath("pnpm-lock.yaml")).toBe(true);
    expect(isGeneratedPath("web/dist/app.min.js")).toBe(true);
    expect(isGeneratedPath("web/dist/app.js.map")).toBe(true);
    expect(isGeneratedPath("src/order.js")).toBe(false);
  });

  it("splitByBudget bütçeyi aşanı erteler ama en az bir dosya gönderir", () => {
    const make = (p: string, size: number): FileDiff => ({
      path: p,
      oldPath: null,
      status: "modified",
      patch: "x".repeat(size),
      additions: 1,
      deletions: 0,
      blobHash: "a".repeat(40),
      truncated: false,
      collapsedByDefault: false,
    });

    const split = splitByBudget([make("a", 900), make("b", 300), make("c", 10)], 1000);
    expect(split.send.map((f) => f.path)).toEqual(["a"]);
    expect(split.defer.map((f) => f.path)).toEqual(["b", "c"]);

    const huge = splitByBudget([make("tek", 5000)], 1000);
    expect(huge.send).toHaveLength(1);
    expect(huge.defer).toHaveLength(0);
  });

  it("fingerprint blob ve duruma bağlı", () => {
    const f: FileDiff = {
      path: "a",
      oldPath: null,
      status: "modified",
      patch: "",
      additions: 0,
      deletions: 0,
      blobHash: "abc",
      truncated: false,
      collapsedByDefault: false,
    };
    expect(fingerprint(f)).not.toBe(fingerprint({ ...f, blobHash: "def" }));
    expect(fingerprint(f)).not.toBe(fingerprint({ ...f, status: "added" }));
  });
});
