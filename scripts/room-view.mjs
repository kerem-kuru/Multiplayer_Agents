/**
 * Odanın CANLI görünümü — tarayıcının gördüğünün aynısı.
 *
 *   node scripts/room-view.mjs <roomId> --base URL --session <çerez> [--agent backend]
 *
 * Neden var: `GET /rooms/:id/snapshot` SAKLANAN snapshot'ı döndürür, canlı
 * durumu değil. Snapshot periyodik üretiliyor, yani her zaman event log'un
 * gerisinde olabilir. Hafta 6 agent kapısı bir koşumda tam bu yüzden düştü:
 * yorum seq 48'de yazılmıştı, snapshot seq 34'te kalmıştı ve kapı "projeksiyonda
 * yorum yok" dedi. Ürün doğruydu, kapının okuması yanlıştı.
 *
 * İstemci ne yapıyorsa o yapılıyor (`apps/web/src/lib/useEventStream.ts`):
 * snapshot + ondan SONRAKİ event'ler → `project()`. Tek gerçek kaynak event log.
 *
 * Çıktı: tam `RoomView` JSON'u, ya da `--agent` verilirse o agent'ın görünümü.
 */

import { project } from "../packages/view/dist/project.js";

const args = process.argv.slice(2);
const roomId = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

if (!roomId) {
  console.error("kullanım: node scripts/room-view.mjs <roomId> --base URL --session <çerez>");
  process.exit(1);
}

const base = flag("base", "http://localhost:8787");
const session = flag("session", process.env.ROOMS_SESSION ?? "");
const agent = flag("agent", "");

// project() bilinmeyen event tipi gorunce console.debug ile UYARIR ve Node'da
// console.debug STDOUT'a yazar — JSON ciktisini kirletip cagiranin
// JSON.parse'ini dusurur. Uyari stderr'e alindi. (22 Eylul: Hafta 6 kapisinin
// 11. kontrolu tam bu yuzden "?" dondu.)
console.debug = (...a) => process.stderr.write(a.join(" ") + "\n");

const get = async (path) => {
  const res = await fetch(`${base}${path}`, {
    headers: session ? { cookie: `rooms_session=${session}` } : {},
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
};

const snap = await get(`/rooms/${roomId}/snapshot`).catch(() => null);
const baseState = snap?.state ?? undefined;
let since = snap?.seq ?? 0;

/** Sayfalayarak oku: uç tek çağrıda 500 event ile sınırlı. */
const events = [];
for (;;) {
  const page = await get(`/rooms/${roomId}/events?since=${since}&limit=500`);
  events.push(...(page.events ?? []));
  if (!page.hasMore || !page.events?.length) break;
  since = page.events[page.events.length - 1].seq;
}

const view = project(events, baseState);
console.log(JSON.stringify(agent ? (view.agents[agent] ?? {}) : view));
