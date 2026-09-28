export * from "./ids.js";
export * from "./paths.js";
export * from "./diff.js";
export * from "./runtime.js";
export * from "./tools.js";
export * from "./events.js";
export * from "./room-config.js";
export * from "./prompts.js";
export * from "./review-prompt.js";
export * from "./runner-protocol.js";
export * from "./stream.js";

/** Protokol sürümü. İstemci ve sunucu bu numarada anlaşmazsa bağlanmaz. */
/**
 * Hafta 7'de 4'e cikti: runner protokolune `isolation_drift` ciktisi ve
 * contracts takibi girdi. Bayat imajla agent `stopped`da kalir ve sunucu
 * logunda "imaj protokol surumu uyusmuyor" yazar → `npm run room:build`.
 */
/**
 * 5: `turn.retrying` event'i ve `turn.failed` icin `retry_exhausted` sebebi
 * (24 Eylul — saglayici 503'u ekranda gorunmuyordu ve denemeler kotayi yiyordu).
 */
/**
 * 6: `contract.changed` silmede bos `sha256` kabul ediyor (29 Eylul). Runner
 * event'i kendi icinde dogruluyor — bayat imaj silmeyi yine dusururdu.
 */
/**
 * 7: `turn.retrying.waitMs` — bekleme sureli 429 art arda butceden dusmez,
 * `attempt` 0 olabilir (29 Eylul). Bayat imaj 429'da saglikli turn'u oldururdu.
 */
export const PROTOCOL_VERSION = 7;
