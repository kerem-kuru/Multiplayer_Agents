/**
 * Yol normalleştirme ve kapsama kontrolü — `node:path` KULLANMADAN.
 *
 * Neden: bu paket tarayıcıya da gidiyor (`apps/web` şimdilik yalnızca `import
 * type` ile kullanıyor ama bir gün değer import'u eklenirse `node:path`
 * tarayıcı derlemesini kırar). Kontrolün kendisi saf string işi olduğu için
 * Node'a bağımlı olmasına gerek yok.
 *
 * Hafta 7, Adım 1: `repo.kind = "local"` kaynağının `ROOMS_SOURCE_ROOT`
 * altında kaldığını doğrulamak için kullanılıyor — sunucu makinesinde keyfi
 * dosya okumayı engeller.
 */

/**
 * Yolu leksik olarak normalleştirir: ayraçları `/` yapar, `.` ve `..`
 * segmentlerini çözer, tekrar eden ayraçları ve sondaki ayracı atar.
 *
 * Leksik çözüm sembolik bağları TAKİP ETMEZ. Bu bilinçli: symlink çözümü
 * dosya sistemine gitmek demek ve bu fonksiyonun saf kalması gerekiyor.
 * Symlink ile kaçışa karşı asıl savunma, kaynağın container'a salt okunur
 * bağlanması ve klonun ayrı bir container'da yapılmasıdır (Adım 4).
 */
export function normalizePath(p: string): string {
  let s = p.split("\\").join("/");

  // Windows sürücü harfi: "C:/x" → "c:/x" (karşılaştırma büyük/küçük harf duyarsız olsun)
  const drive = /^([a-zA-Z]):\//.exec(s);
  let prefix = "";
  const letter = drive?.[1];
  if (drive && letter) {
    prefix = `${letter.toLowerCase()}:`;
    s = s.slice(drive[0].length - 1);
  }

  const absolute = s.startsWith("/");
  const out: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Kökün üstüne çıkılamaz; göreli yolda ".." korunur ki kapsama testi düşsün.
      const last = out.length > 0 ? out[out.length - 1] : undefined;
      if (last !== undefined && last !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }

  const body = out.join("/");
  if (prefix) return `${prefix}/${body}`;
  return absolute ? `/${body}` : body;
}

/**
 * `child`, `root`un kendisi mi ya da altında mı?
 *
 * Segment sınırına bakar: `/srv/repos-gizli` yolu `/srv/repos` altında SAYILMAZ.
 * Boş `root` her zaman `false` döndürür — "kök tanımsızsa hiçbir şey izinli
 * değil" kuralı çağıran tarafta unutulmasın diye burada da geçerli.
 */
export function isInside(root: string, child: string): boolean {
  if (!root.trim()) return false;
  const r = normalizePath(root);
  const c = normalizePath(child);
  if (!r || !c) return false;
  return c === r || c.startsWith(r.endsWith("/") ? r : `${r}/`);
}
