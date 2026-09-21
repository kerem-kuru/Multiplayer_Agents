import { z } from "zod";

/**
 * Bir dosyanın diff'i — TEK TANIM.
 *
 * Şema burada duruyor, `gitkit` içinde değil: aynı şekli hem üreten taraf
 * (container içindeki gitkit) hem tüketen taraf (event log, projeksiyon, UI)
 * kullanıyor. İki ayrı tanım olsaydı biri diğerinden sessizce ayrılırdı ve
 * fark ancak ekranda boş bir dosya kartı olarak görünürdü.
 */

export const FileStatus = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "binary",
  /**
   * Tabana geri döndü: artık diff'te YOK. Artımlı yayımda bir dosyanın
   * listeden çıktığını söylemenin tek yolu bu — aksi hâlde dosya kartı
   * ekranda sonsuza kadar asılı kalırdı.
   */
  "clean",
]);
export type FileStatus = z.infer<typeof FileStatus>;

export const FileDiff = z.object({
  path: z.string().min(1),
  /** Yeniden adlandırmada eski yol. */
  oldPath: z.string().min(1).nullable(),
  status: FileStatus,
  /** Unified, 3 satır bağlam. `binary` ve `clean` için null. */
  patch: z.string().nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Yeni taraftaki blob sha'sı — artımlı yayım değişikliği bundan anlar. */
  blobHash: z.string().nullable(),
  /** Patch dosya başına 32 KB'da kırpıldı. */
  truncated: z.boolean(),
  /** Lock ve üretilmiş dosyalar kapalı başlar. */
  collapsedByDefault: z.boolean(),
});
export type FileDiff = z.infer<typeof FileDiff>;

/** Checkpoint kimliği: `cp_` + 12 hex. Ref adında, event'te ve UI'da görünüyor. */
export const CheckpointId = z.string().regex(/^cp_[0-9a-f]{6,32}$/, "checkpoint kimliği geçersiz");
export type CheckpointId = z.infer<typeof CheckpointId>;

/**
 * Checkpoint türleri.
 *
 * `baseline`: agent ilk başlatılırken bir kez. `manual`: insan aldı, yeni
 * taban olur. `turn`: her tamamlanan turn'ün sonunda, TABAN OLMAZ — "Ayşe'nin
 * 14:02 mesajından sonrası" diye geri bakılabilsin diye.
 */
export const CheckpointKind = z.enum(["baseline", "manual", "turn"]);
export type CheckpointKind = z.infer<typeof CheckpointKind>;

/**
 * Bir satır yorumunun çapası — satır numarası TEK BAŞINA kaymaz bir şey değil.
 *
 * `current`: yorumun yazıldığı satır hâlâ aynı yerde ve aynı metinde.
 * `moved`: aynı metin dosyada başka bir satırda TEK kez geçiyor.
 * `outdated`: agent o satırı değiştirdi, sildi ya da metin birden çok yerde
 * geçiyor. Sessizce yanlış satıra kaymaktansa "eskimiş" demek doğrudur.
 */
export const AnchorState = z.enum(["current", "moved", "outdated"]);
export type AnchorState = z.infer<typeof AnchorState>;

/** Yorum diff'in hangi tarafına bırakıldı: yeni (eklenen/bağlam) veya eski (silinen). */
export const CommentSide = z.enum(["new", "old"]);
export type CommentSide = z.infer<typeof CommentSide>;
