/**
 * Başsız SSE istemcisi — "event kaybolmuyor" kanıtını UI'DAN BAĞIMSIZ üretir.
 *
 *   node scripts/sse-probe.mjs <roomId> [--since N] [--drop-after N]
 *                              [--out dosya.json] [--duration SN] [--base URL]
 *
 * Kapı testinin omurgası. UI'da bir şeyin görünmemesi iki sebepten olabilir:
 * sunucu göndermedi, ya da istemci çizmedi. Bu probe ikisini ayırır.
 *
 * `--drop-after N`: N event aldıktan sonra bağlantıyı ZORLA koparır, 1 sn
 * bekler, `since=lastSeq` ile yeniden bağlanır. Kopma senaryosunu test
 * etmenin yolu budur.
 *
 * Çıkışta boşluk ve tekrar sayısını basar; ikisi de 0 olmalı.
 */

const args = process.argv.slice(2);
const roomId = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const session = flag("session", process.env.ROOMS_SESSION ?? "");

if (!roomId) {
  console.error(
    "kullanım: node scripts/sse-probe.mjs <roomId> [--since N] [--drop-after N] [--out f.json] [--duration SN]",
  );
  process.exit(1);
}

const base = flag("base", "http://localhost:8787");
const since0 = Number(flag("since", 0));
const dropAfter = args.includes("--drop-after") ? Number(flag("drop-after", 0)) : 0;
const outFile = flag("out", "");
/** Presence frame'lerini ayrı dosyaya yaz — Hafta 4 kapısı bunu okuyor. */
const presenceOut = flag("presence-out", "");
const durationSec = Number(flag("duration", 30));

const seen = new Map(); // seq -> event
let duplicates = 0;
let frames = 0;
let reconnects = 0;
/** Presence AYRI kanal: event sayımına karışmaz. */
const presenceFrames = []; // { atMs, people }
const startedAt = Date.now();
let firstFrameMs = null;

/** SSE gövdesini çerçevelere böl ve alanları ayıkla. */
function parseFrames(buffer) {
  const out = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const frame = { event: "message", data: [], id: null };
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // yorum / ping
      const sep = line.indexOf(":");
      const field = sep < 0 ? line : line.slice(0, sep);
      const value = sep < 0 ? "" : line.slice(sep + 1).replace(/^ /, "");
      if (field === "event") frame.event = value;
      else if (field === "data") frame.data.push(value);
      else if (field === "id") frame.id = value;
    }
    out.push(frame);
  }
  return { frames: out, rest };
}

function ingest(frame) {
  if (frame.event === "overflow") {
    console.error("  ! sunucu overflow bildirdi:", frame.data.join(""));
    return "overflow";
  }
  if (frame.event === "presence") {
    try {
      presenceFrames.push({ atMs: Date.now() - startedAt, people: JSON.parse(frame.data.join("")) });
    } catch {
      // Bozuk presence frame'i ölçümü düşürmesin.
    }
    if (firstFrameMs === null) firstFrameMs = Date.now() - startedAt;
    return null;
  }
  if (frame.event !== "events") return null;
  let events;
  try {
    events = JSON.parse(frame.data.join(""));
  } catch {
    console.error("  ! frame ayrıştırılamadı");
    return null;
  }
  frames += 1;
  if (firstFrameMs === null) firstFrameMs = Date.now() - startedAt;
  for (const e of events) {
    if (seen.has(e.seq)) duplicates += 1;
    else seen.set(e.seq, e);
  }
  return null;
}

const lastSeq = () => (seen.size === 0 ? since0 : Math.max(...seen.keys()));

async function connect(since, budgetMs, stopAfterEvents) {
  const url = `${base}/rooms/${roomId}/events?since=${since}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetMs);

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "text/event-stream",
        // Hafta 4: SSE de yetki ister. Çerezi ortamdan veya --session ile al.
        ...(session ? { cookie: `rooms_session=${session}` } : {}),
      },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (ac.signal.aborted) return "timeout";
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    console.error(`  ! bağlantı ${res.status}`);
    return "error";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reason = "timeout";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        reason = "closed";
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (ingest(frame) === "overflow") {
          reason = "overflow";
          ac.abort();
          break;
        }
      }
      if (reason === "overflow") break;
      // Kopma senaryosu: yeterince event aldıysak bağlantıyı ZORLA kes.
      if (stopAfterEvents > 0 && seen.size >= stopAfterEvents) {
        reason = "dropped";
        ac.abort();
        break;
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return reason;
}

const deadline = Date.now() + durationSec * 1000;
let mode = dropAfter > 0 ? dropAfter : 0;

while (Date.now() < deadline) {
  const budget = Math.max(1000, deadline - Date.now());
  const reason = await connect(lastSeq(), budget, mode);

  if (reason === "dropped" || reason === "overflow") {
    reconnects += 1;
    // Kopmayı bir kez yap; yeniden bağlandıktan sonra sonuna kadar dinle.
    mode = 0;
    console.error(`  · bağlantı koptu (${reason}), 1 sn sonra since=${lastSeq()} ile dönülüyor`);
    await new Promise((r) => setTimeout(r, 1000));
    continue;
  }
  if (reason === "closed") {
    await new Promise((r) => setTimeout(r, 500));
    continue;
  }
  break; // timeout: süre doldu
}

// --- özet ---
const seqs = [...seen.keys()].sort((a, b) => a - b);
let gaps = 0;
const missing = [];
for (let i = 1; i < seqs.length; i++) {
  const step = seqs[i] - seqs[i - 1];
  if (step > 1) {
    gaps += step - 1;
    missing.push(`${seqs[i - 1] + 1}..${seqs[i] - 1}`);
  }
}

if (presenceOut) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(presenceOut, JSON.stringify(presenceFrames, null, 2), "utf8");
}

if (outFile) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outFile, JSON.stringify(seqs.map((s) => seen.get(s)), null, 2), "utf8");
}

const summary = {
  events: seen.size,
  range: seqs.length > 0 ? `${seqs[0]}..${seqs[seqs.length - 1]}` : "-",
  frames,
  gaps,
  duplicates,
  reconnects,
  eventsPerFrame: frames > 0 ? Number((seen.size / frames).toFixed(2)) : 0,
  /** İlk anlamlı frame'e kadar geçen süre — "3 saniyede senkron" ölçümü. */
  firstFrameMs,
  presenceFrames: presenceFrames.length,
  people: presenceFrames.length > 0 ? presenceFrames[presenceFrames.length - 1].people.length : 0,
};
console.log(JSON.stringify(summary));

if (gaps > 0) {
  console.error(`BOŞLUK VAR: ${missing.join(", ")}`);
  process.exit(1);
}
process.exit(0);
