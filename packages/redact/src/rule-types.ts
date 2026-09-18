/**
 * Kural sözleşmesi — üretilen dosya ile elle yazılan kurallar aynı şekli
 * kullanır ki motor ikisini ayırt etmek zorunda kalmasın.
 */
export interface RuleSpec {
  /** gitleaks id'si veya bizim verdiğimiz ad; bulguda bu isim görünür. */
  id: string;
  /** JS RegExp kaynağı. `d` bayrağı zorunlu: grup konumları lazım. */
  pattern: string;
  flags: string;
  /**
   * Ön filtre: bu kelimelerden HİÇBİRİ metinde yoksa regex çalıştırılmaz.
   * Boş dizi = her metinde çalışır (pahalı; sayısını sınırlı tut).
   */
  keywords: readonly string[];
  /** Eşleşen değerin Shannon entropisi bunun altındaysa bulgu sayılmaz. */
  entropy?: number;
  /** Secret'ın hangi yakalama grubunda olduğu; yoksa eşleşmenin tamamı. */
  secretGroup?: number;
}
