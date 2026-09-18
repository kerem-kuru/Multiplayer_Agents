import { compileAllowPatterns, redactPayload, type Finding } from "@agent-rooms/redact";

/**
 * Redaction geçidinin oda ayarları.
 *
 * `appendEvent` yüzlerce yerden çağrılıyor ve hiçbiri oda konfigürasyonunu
 * taşımıyor. Ayarı imzaya eklemek her çağrı yerini değiştirmek demekti; onun
 * yerine oda açılırken buraya kaydediliyor ve geçit `roomId` ile buluyor.
 */

const perRoom = new Map<string, RegExp[]>();
let fallback: RegExp[] = [];

export function setRoomAllowPatterns(roomId: string, patterns: readonly string[]): void {
  perRoom.set(roomId, compileAllowPatterns(patterns));
}

/** Sunucu açılışında yüklenen konfigürasyon — odası kayıtlı olmayanlar için. */
export function setDefaultAllowPatterns(patterns: readonly string[]): void {
  fallback = compileAllowPatterns(patterns);
}

export function getAllowPatterns(roomId: string): RegExp[] {
  return perRoom.get(roomId) ?? fallback;
}

export function forgetRoomAllowPatterns(roomId: string): void {
  perRoom.delete(roomId);
}

/** Event payload'ını odanın ayarlarıyla temizle. */
export function redactEventPayload(
  roomId: string,
  payload: unknown,
): { payload: unknown; findings: Finding[] } {
  return redactPayload(payload, { allowPatterns: getAllowPatterns(roomId) });
}
