import type { DraftComment } from "./api.js";

/**
 * Taslak yorumlar — YALNIZCA yazan kişinin tarayıcısında.
 *
 * Sunucuya gitmezler ve başkaları GÖNDERİLENE KADAR görmez. Sebep: yarım
 * yazılmış bir yorum bir yönerge değildir; onu odadakilere canlı göstermek,
 * "bunu böl" yazmaya başlayan birini daha cümlesi bitmeden tartışmaya sokar.
 *
 * `localStorage` oda + agent anahtarıyla: sekme kapanıp açılınca taslaklar
 * duruyor. Bu bir SUNUM kolaylığı — kaybolursa iş durmaz, o yüzden
 * event log'a girmiyor.
 */

export interface Draft extends DraftComment {
  /** Yalnızca istemci içi: listede kimliklendirmek ve silmek için. */
  id: string;
}

const key = (roomId: string, agent: string): string => `rooms:drafts:${roomId}:${agent}`;

export function loadDrafts(roomId: string, agent: string): Draft[] {
  try {
    const raw = localStorage.getItem(key(roomId, agent));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Draft[]) : [];
  } catch {
    // Bozuk veya erişilemeyen depo taslakları kaybettirir, ekranı çökertmez.
    return [];
  }
}

export function saveDrafts(roomId: string, agent: string, drafts: Draft[]): void {
  try {
    if (drafts.length === 0) localStorage.removeItem(key(roomId, agent));
    else localStorage.setItem(key(roomId, agent), JSON.stringify(drafts));
  } catch {
    // Kotayı aşan veya kapalı depo: taslak bellekte yaşamaya devam eder.
  }
}

export const newDraftId = (): string =>
  `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
