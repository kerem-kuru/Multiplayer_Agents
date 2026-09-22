import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ROOMS_INDEX,
  checkpointRef,
  createCheckpoint,
  currentTree,
  git,
  initWorkspace,
  newCheckpointId,
  resolveCheckpointTree,
} from "../src/index.js";

/**
 * GERÇEK git ile, geçici klasörlerde.
 *
 * Sahte (mock) bir git ile yazılmış checkpoint testi hiçbir şey kanıtlamaz:
 * kanıtlamaya çalıştığımız şey tam olarak git'in HEAD'e, index'e ve çalışma
 * ağacına dokunup dokunmadığı.
 */

let dir: string;

const write = async (rel: string, body: string): Promise<void> => {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
};

/** Dosya yoksa null — taze bir depoda `.git/index` HİÇ yaratılmamış olabilir. */
const fileHash = async (rel: string): Promise<string | null> => {
  try {
    const buf = await fs.readFile(path.join(dir, rel));
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitkit-cp-"));
  // Hafta 7: gitkit artik depo YARATMIYOR — oda acilisinda merkezden
  // klonlaniyor. Testler de depoyu kendileri kurar.
  await git(dir, ["init", "-b", "main"]);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("initWorkspace", () => {
  it("depo olmayan klasoru REDDEDER — sessizce git init etmez", async () => {
    // Sessizce init etseydi alternates'i ve dogru branch'i olmayan bir depo
    // kurulur, agent calisir ve merkeze hic bagli olmadigi cok sonra anlasilirdi.
    const bos = await fs.mkdtemp(path.join(os.tmpdir(), "gitkit-bos-"));
    try {
      await expect(initWorkspace(bos)).rejects.toThrow(/git deposu degil|git deposu değil/);
    } finally {
      await fs.rm(bos, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("var olan depoda taban checkpoint'i alır", async () => {
    await write("src/order.js", "function processOrder() {}\n");

    const res = await initWorkspace(dir);

    expect(res.created).toBe(false);
    expect(res.checkpointId).toMatch(/^cp_[0-9a-f]{12}$/);
    expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);
    // Taban, workspace'in O ANKİ hâli: takip edilmeyen dosya da ağaçta.
    const ls = await git(dir, ["ls-tree", "-r", "--name-only", res.treeSha]);
    expect(ls).toContain("src/order.js");
  });

  it("var olan depoda yeni commit yaratmaz, HEAD'i değiştirmez", async () => {
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.name", "t"]);
    await git(dir, ["config", "user.email", "t@t"]);
    await write("a.txt", "a\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "ilk"]);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();

    const res = await initWorkspace(dir);

    expect(res.created).toBe(false);
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(head);
  });

  it("info/exclude'a bizim kalıpları ekler, .gitignore'a dokunmaz", async () => {
    await write(".gitignore", "kullanicinin-kurali\n");
    await initWorkspace(dir);

    const exclude = await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("node_modules/");
    expect(exclude).toContain("__pycache__/");
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf8")).toBe("kullanicinin-kurali\n");
  });

  it("iki kez çağrılınca exclude satırları tekrarlanmaz", async () => {
    await initWorkspace(dir);
    await initWorkspace(dir);
    const exclude = await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8");
    const hits = exclude.split(/\r?\n/).filter((l) => l.trim() === "node_modules/");
    expect(hits).toHaveLength(1);
  });
});

describe("createCheckpoint", () => {
  it("branch'e, HEAD'e, index'e ve çalışma ağacına DOKUNMAZ", async () => {
    await write("src/order.js", "function processOrder() {}\n");
    await initWorkspace(dir);

    // Kullanıcının kendi index'i: bir dosyayı sahneye al, sonra karşılaştır.
    await write("staged.txt", "sahnede\n");
    await git(dir, ["add", "staged.txt"]);

    const before = {
      head: (await git(dir, ["rev-parse", "HEAD"])).trim(),
      status: await git(dir, ["status", "--porcelain"]),
      index: await fileHash(".git/index"),
      branch: (await git(dir, ["symbolic-ref", "HEAD"])).trim(),
    };

    await write("src/order.js", "function processOrder() { return 1 }\n");
    const cp = await createCheckpoint(dir, newCheckpointId(), "öğle arası");

    const after = {
      head: (await git(dir, ["rev-parse", "HEAD"])).trim(),
      status: await git(dir, ["status", "--porcelain"]),
      index: await fileHash(".git/index"),
      branch: (await git(dir, ["symbolic-ref", "HEAD"])).trim(),
    };

    expect(after).toEqual(before);
    expect(cp.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ref yaratır ve ağaç ondan çözülebilir", async () => {
    await write("a.txt", "a\n");
    await initWorkspace(dir);
    const id = newCheckpointId();
    const cp = await createCheckpoint(dir, id, "elle");

    const ref = (await git(dir, ["rev-parse", "--verify", checkpointRef(id)])).trim();
    expect(ref).toBe(cp.commitSha);
    expect(await resolveCheckpointTree(dir, id)).toBe(cp.treeSha);
  });

  it("olmayan checkpoint için null döner", async () => {
    await initWorkspace(dir);
    expect(await resolveCheckpointTree(dir, "cp_yok")).toBeNull();
  });

  it("node_modules ağaca girmez, takip edilmeyen yeni dosya girer", async () => {
    await initWorkspace(dir);
    await write("node_modules/x/index.js", "module.exports = 1\n");
    await write("yeni.txt", "yeni\n");

    const tree = await currentTree(dir);
    const ls = await git(dir, ["ls-tree", "-r", "--name-only", tree]);

    expect(ls).toContain("yeni.txt");
    expect(ls).not.toContain("node_modules");
  });

  it("geçici index kalıcıdır — kullanıcının index'inden ayrı bir dosya", async () => {
    await write("a.txt", "a\n");
    await initWorkspace(dir);
    await currentTree(dir);
    const stat = await fs.stat(path.join(dir, ROOMS_INDEX));
    expect(stat.isFile()).toBe(true);
  });
});
