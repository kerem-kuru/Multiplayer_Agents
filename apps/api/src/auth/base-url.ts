import type { Context } from "hono";
import type { ApiConfig } from "../config.js";

/**
 * Giriş ve davet bağlantılarının gövdesi.
 *
 * `APP_BASE_URL` sabit bir IP taşıyordu (`192.168.1.114`); makine başka ağa
 * geçince her bağlantı ulaşılamayan bir adrese gitti ve giriş yapılamadı.
 * Değişken VERİLMEDİYSE bağlantı, arayüzün gerçekten açıldığı adresten
 * (`Origin`) üretilir: localhost'tan giren localhost bağlantısı, ağdaki IP'den
 * giren o IP'nin bağlantısını alır. Verildiyse (tünel, üretim) o kazanır.
 *
 * `trustOrigin` false ise Origin'e HİÇ bakılmaz. Giriş bağlantısı e-postayla
 * gidecekse (AUTH_DEV_MODE kapalı) Origin'e güvenmek zehirleme açığıdır:
 * saldırgan başlığı kendi alan adıyla gönderip kurbanın e-postasına
 * kendi sitesine giden bir token yollatır. Dev modda bağlantı isteyene ekranda
 * gösterildiği için başka birine gitmiyor. Davet bağlantısı da yalnızca
 * oluşturan sahibin yanıtına düşüyor.
 */
export function linkBaseUrl(c: Context, cfg: ApiConfig, trustOrigin: boolean): string {
  if (cfg.appBaseUrlFixed !== false || !trustOrigin) return cfg.appBaseUrl;
  const origin = c.req.header("origin");
  if (!origin) return cfg.appBaseUrl;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return cfg.appBaseUrl;
    return u.origin;
  } catch {
    return cfg.appBaseUrl;
  }
}
