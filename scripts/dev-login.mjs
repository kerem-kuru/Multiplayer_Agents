/**
 * Geliştirme girişi — kapı script'leri ve elle deneme için.
 *
 *   TOKEN=$(node scripts/dev-login.mjs --base http://localhost:8787 --email a@b.c)
 *   curl -b "rooms_session=$TOKEN" http://localhost:8787/rooms
 *
 * Yetkilendirmede kısayol YOK: bu script de normal magic link akışını koşar,
 * sadece linki e-posta yerine doğrudan alır (AUTH_DEV_MODE=true gerekir).
 */
import { devSession } from "./dev-session.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

try {
  const session = await devSession(arg("base", "http://localhost:8787"), arg("email", "gate@rooms.local"));
  process.stdout.write(session);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}
