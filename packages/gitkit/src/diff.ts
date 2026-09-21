import type { FileDiff, FileStatus } from "@agent-rooms/protocol";
import { git } from "./git.js";

/**
 * Taban ağacı ↔ şu anki ağaç, DOSYA BAZINDA.
 *
 * Tek bir büyük diff metni değil dosya listesi üretiliyor, çünkü canlı yayım
 * artımlı: her araç çağrısından sonra tüm diff yeniden gönderilirse event log
 * şişer ve ikinci kullanıcının ekranı her seferinde baştan çizilir.
 *
 * `FileDiff` şekli `@agent-rooms/protocol` içinde TEK KEZ tanımlı: burada
 * ikinci bir tanım olsaydı üreten ile tüketen zamanla sessizce ayrılırdı.
 */
export type { FileDiff, FileStatus };

/** Dosya başına patch sınırı. Aşarsa kırpılır ve `truncated` bunu söyler. */
export const PATCH_LIMIT_BYTES = 32 * 1024;
/** Bir `diff.updated` event'inin toplam patch bütçesi. Aşan dosyalar sonraki event'e kalır. */
export const EVENT_BUDGET_BYTES = 256 * 1024;
/** Bu kadar satırdan uzun patch'ler kapalı başlar. */
export const COLLAPSE_LINE_LIMIT = 1000;

const COLLAPSE_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /\.min\.js$/,
  /\.map$/,
];

export function isGeneratedPath(p: string): boolean {
  return COLLAPSE_PATTERNS.some((re) => re.test(p));
}

interface RawEntry {
  status: string;
  path: string;
  oldPath: string | null;
  newBlob: string | null;
}

const NULL_SHA = /^0+$/;

/**
 * `git diff --raw -z` çıktısı: `:<mod> <mod> <sha> <sha> <durum>\0<yol>\0`
 * (yeniden adlandırmada `\0<eski>\0<yeni>\0`).
 *
 * Ayrıştırma NUL üzerinden: dosya adında boşluk veya yeni satır olabilir ve
 * git bunları -z olmadan tırnak içine alıp kaçış dizileriyle yazar. "Metin
 * kazıma yok" kuralı burada da geçerli — biçimi biz seçiyoruz.
 */
export function parseRawZ(out: string): RawEntry[] {
  const tok = out.split("\0").filter((t) => t.length > 0);
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < tok.length) {
    const meta = tok[i++]!;
    if (!meta.startsWith(":")) continue;
    const fields = meta.slice(1).split(" ");
    const status = fields[4] ?? "M";
    const newBlob = fields[3] ?? null;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const oldPath = tok[i++] ?? "";
      const path = tok[i++] ?? "";
      entries.push({ status, path, oldPath, newBlob });
    } else {
      const path = tok[i++] ?? "";
      entries.push({ status, path, oldPath: null, newBlob });
    }
  }
  return entries;
}

function mapStatus(raw: string): FileStatus {
  switch (raw[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    // C = kopya. Yeni taraf için "eklendi"den farkı yok.
    case "C":
      return "added";
    default:
      return "modified";
  }
}

/** `git diff --numstat -z` tek dosya için: `<ekleme>\t<silme>\t<yol>`. Binary'de `-\t-`. */
export function parseNumstat(out: string): {
  additions: number;
  deletions: number;
  binary: boolean;
} {
  const first = out.split("\0")[0] ?? "";
  const [a, d] = first.split("\t");
  if (a === "-" || d === "-") return { additions: 0, deletions: 0, binary: true };
  return { additions: Number(a ?? 0) || 0, deletions: Number(d ?? 0) || 0, binary: false };
}

/**
 * Kırpma satır sınırında yapılır: yarım kalmış bir diff satırı istemcide
 * ayrıştırılamaz bir şey olurdu.
 */
function clip(patch: string, limit: number): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, "utf8") <= limit) return { patch, truncated: false };
  let cut = Buffer.from(patch, "utf8").subarray(0, limit).toString("utf8");
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > 0) cut = cut.slice(0, lastNl + 1);
  return { patch: cut, truncated: true };
}

export interface DiffOptions {
  patchLimitBytes?: number;
}

export async function diffTrees(
  cwd: string,
  baseTree: string,
  curTree: string,
  opts: DiffOptions = {},
): Promise<FileDiff[]> {
  const limit = opts.patchLimitBytes ?? PATCH_LIMIT_BYTES;
  const raw = await git(cwd, ["diff", "--raw", "-M", "-z", "--abbrev=40", baseTree, curTree]);
  const entries = parseRawZ(raw);

  const files: FileDiff[] = [];
  for (const e of entries) {
    /**
     * Yeniden adlandırmada pathspec'e HER İKİ yol da verilir: yalnızca yeni
     * yolu verirsek eski yolun silinmesi filtreden düşer, git yeniden
     * adlandırmayı göremez ve dosya "eklendi" gibi görünür.
     */
    const paths = e.oldPath ? [e.oldPath, e.path] : [e.path];
    const pathspec = ["--", ...paths];

    const numstat = parseNumstat(
      await git(cwd, ["diff", "--numstat", "-M", "-z", baseTree, curTree, ...pathspec]),
    );

    const blobHash = e.newBlob && !NULL_SHA.test(e.newBlob) ? e.newBlob : null;
    const base = {
      path: e.path,
      oldPath: e.oldPath,
      blobHash,
      additions: numstat.additions,
      deletions: numstat.deletions,
    };

    if (numstat.binary) {
      files.push({
        ...base,
        status: "binary",
        patch: null,
        additions: 0,
        deletions: 0,
        truncated: false,
        collapsedByDefault: true,
      });
      continue;
    }

    const full = await git(cwd, [
      "diff",
      "-M",
      "--no-color",
      "--unified=3",
      baseTree,
      curTree,
      ...pathspec,
    ]);
    const { patch, truncated } = clip(full, limit);
    const lines = patch.length === 0 ? 0 : patch.split("\n").length;

    files.push({
      ...base,
      status: mapStatus(e.status),
      patch,
      truncated,
      collapsedByDefault: isGeneratedPath(e.path) || lines > COLLAPSE_LINE_LIMIT,
    });
  }

  // Sıra determinist olsun: aynı ağaç çifti her zaman aynı diziyi versin.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

// --- artımlı yayım ---------------------------------------------------------

/**
 * Bir dosyanın "aynı mı" parmak izi. Blob sha'sı tek başına yetmiyor:
 * silinmiş bir dosyanın yeni tarafı yok (blob null) ve her turda yeniden
 * gönderilirdi.
 */
export function fingerprint(f: FileDiff): string {
  return `${f.status}:${f.blobHash ?? ""}:${f.oldPath ?? ""}:${f.truncated ? "t" : ""}`;
}

export interface IncrementalResult {
  /** Bu event'te gidecek dosyalar. Boşsa event YAZILMAZ. */
  changed: FileDiff[];
  /** Yeni parmak izi haritası — yalnızca GÖNDERİLENLER işaretlenir. */
  next: Map<string, string>;
}

/**
 * Artımlı filtre: yalnızca parmak izi değişen, yeni eklenen veya diff'ten
 * çıkan dosyalar gönderilir.
 *
 * Diff'ten çıkan dosya için `status: "clean"` bir kayıt üretilir — istemci
 * "bu dosya artık değişmemiş" bilgisini başka türlü alamaz, dosya listede
 * asılı kalırdı.
 */
export function incremental(prev: Map<string, string>, current: FileDiff[]): IncrementalResult {
  const changed: FileDiff[] = [];
  const next = new Map(prev);
  const seen = new Set<string>();

  for (const f of current) {
    seen.add(f.path);
    const fp = fingerprint(f);
    if (prev.get(f.path) === fp) continue;
    changed.push(f);
    next.set(f.path, fp);
  }

  for (const path of prev.keys()) {
    if (seen.has(path)) continue;
    changed.push({
      path,
      oldPath: null,
      status: "clean",
      patch: null,
      additions: 0,
      deletions: 0,
      blobHash: null,
      truncated: false,
      collapsedByDefault: false,
    });
    next.delete(path);
  }

  return { changed, next };
}

/**
 * Event bütçesi. Bir event'e sığmayan dosyalar SONRAKİ event'e kalır — tek bir
 * araç çağrısı 5 MB'lık bir event yazmasın.
 *
 * En az bir dosya her zaman gider: tek başına bütçeyi aşan bir dosya sonsuza
 * kadar ertelenirse hiç görünmez.
 */
export function splitByBudget(
  files: FileDiff[],
  budget = EVENT_BUDGET_BYTES,
): { send: FileDiff[]; defer: FileDiff[] } {
  const send: FileDiff[] = [];
  let used = 0;
  let i = 0;
  for (; i < files.length; i++) {
    const f = files[i]!;
    const size = f.patch ? Buffer.byteLength(f.patch, "utf8") : 0;
    // Bütçe dolduğunda KALANIN HEPSİ ertelenir. Sığan küçük dosyaları öne
    // almak sırayı bozar ve büyük bir dosyayı sonsuza kadar açlığa mahkûm eder.
    if (send.length > 0 && used + size > budget) break;
    send.push(f);
    used += size;
  }
  return { send, defer: files.slice(i) };
}
