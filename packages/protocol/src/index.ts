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
export const PROTOCOL_VERSION = 5;
