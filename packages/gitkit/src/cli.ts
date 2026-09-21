import {
  createCheckpoint,
  initWorkspace,
  newCheckpointId,
  resolveCheckpointTree,
} from "./checkpoint.js";
import { diffTrees } from "./diff.js";
import { currentTree, isRepo } from "./tree.js";

/**
 * `docker exec` giriş noktası — TEK UYGULAMA, İKİ GİRİŞ NOKTASI.
 *
 * Runner bu modülü import eder (canlı diff yayımı); sunucu ise container
 * içinde `node /opt/runner/gitkit/dist/gitkit.js <komut>` ile çağırır. İkisi
 * aynı kodu koşar, yani "runner'ın gördüğü diff" ile "API'nin döndüğü diff"
 * zamanla birbirinden ayrılamaz.
 *
 * Sözleşme: başarıda stdout'a TEK SATIR JSON, çıkış kodu 0. Hatada stderr'e
 * insan dili, çıkış kodu 1. Sunucu stdout'u ayrıştırır; stderr'i loguna yazar.
 */

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  const cwd = flag(argv, "cwd") ?? process.cwd();

  switch (cmd) {
    case "init-workspace": {
      const res = await initWorkspace(cwd);
      process.stdout.write(JSON.stringify(res) + "\n");
      return;
    }

    case "checkpoint": {
      const id = flag(argv, "id") ?? newCheckpointId();
      const label = flag(argv, "label") ?? "checkpoint";
      const res = await createCheckpoint(cwd, id, label);
      process.stdout.write(JSON.stringify(res) + "\n");
      return;
    }

    case "tree": {
      process.stdout.write(JSON.stringify({ treeSha: await currentTree(cwd) }) + "\n");
      return;
    }

    case "diff": {
      /**
       * Taban ya doğrudan bir ağaç sha'sı (runner'ın elindeki) ya da bir
       * checkpoint kimliği (kullanıcının "şu ana göre" seçimi).
       */
      const byId = flag(argv, "base-checkpoint");
      const baseTree = byId ? await resolveCheckpointTree(cwd, byId) : flag(argv, "base-tree");
      if (!baseTree) {
        process.stderr.write(`taban bulunamadı: ${byId ?? flag(argv, "base-tree") ?? "(yok)"}\n`);
        process.exit(2);
      }
      const cur = await currentTree(cwd);
      const files = await diffTrees(cwd, baseTree, cur);
      process.stdout.write(JSON.stringify({ baseTree, treeSha: cur, files }) + "\n");
      return;
    }

    case "status": {
      process.stdout.write(JSON.stringify({ repo: await isRepo(cwd) }) + "\n");
      return;
    }

    default:
      process.stderr.write(
        `bilinmeyen komut: ${cmd || "(yok)"} — init-workspace | checkpoint | diff | tree | status\n`,
      );
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
