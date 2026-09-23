/**
 * Hafta 7 kapısının çekirdeği doğrudan tetiklediği iki iş.
 *
 * İkisi de sunucuda ZAMANLAYICIYLA koşuyor (denetim 5 dk, sweeper saatte bir);
 * kapı o kadar bekleyemez. Burada aynı fonksiyonlar, aynı DB'ye karşı, bir
 * kez çağrılıyor — kısayol yok, sadece zamanlayıcı yok.
 *
 *   node scripts/lib/w7-core.mjs audit <odaId>   → {"drifts":N,"fixed":bool}
 *   node scripts/lib/w7-core.mjs sweep           → {"removedContainers":[..],...}
 */
process.loadEnvFile?.(".env");

const core = await import("@agent-rooms/core");
const [cmd, roomId] = process.argv.slice(2);

try {
  if (cmd === "audit") {
    const config = await core.getRoomConfig(roomId);
    const session = await core.latestSession(roomId);
    if (!config || !session?.containerId) throw new Error("oda ya da container yok");
    const r = await core.auditRoomIsolation({ roomId, container: session.containerId, config });
    console.log(JSON.stringify({ drifts: r.drifts.length, fixed: r.fixed }));
  } else if (cmd === "sweep") {
    console.log(JSON.stringify(await core.sweepOrphans()));
  } else {
    throw new Error(`bilinmeyen komut: ${cmd}`);
  }
  await core.getPool().end();
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}
