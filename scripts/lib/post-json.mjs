#!/usr/bin/env node
/**
 * Kapı script'lerinin TEK gövde gönderme yolu: gövde stdin'den BAYT olarak
 * okunur, fetch ile gönderilir. curl kullanılmaz, gövde hiçbir yerde string'e
 * çevrilmez (yeniden kodlama yok).
 *
 *   node -e 'console.log(JSON.stringify({ text: process.argv[1] }))' "$METIN" |
 *     node scripts/lib/post-json.mjs "$BASE/rooms/$ROOM/agents/$A/message" --cookie "$S"
 *
 * NEDEN: Git'in curl'ü (mingw) `-d` argümanını UTF-8 değil Windows kod
 * sayfasıyla gönderiyor; kapıların Türkçe mesajları üç hafta "olu�tur" diye
 * kaydedildi (13 Ekim, ölçüldü). Komut satırı argümanı bu makinede bayt
 * taşımak için güvenilir değil; pipe öyle. API artık geçersiz UTF-8'i 400 ile
 * reddediyor (apps/api/src/utf8-body.ts).
 *
 * Seçenekler (curl karşılığı):
 *   --cookie <oturum>     -b "rooms_session=<oturum>"
 *   --method <M>          -X <M>                    (varsayılan POST)
 *   --header "k: v"       -H "k: v"                 (tekrarlanabilir)
 *   --max-time <sn>       --max-time <sn>           (varsayılan 120)
 *   --status              -o /dev/null -w '%{http_code}'  (bağlantı yoksa 000)
 *
 * Çıktı: yanıt gövdesi, olduğu gibi (curl -s gibi; HTTP hatası çıkış kodunu
 * değiştirmez). Bağlantı hatası: stderr'e mesaj, çıkış kodu 7.
 */
const args = process.argv.slice(2);
const opts = { method: "POST", headers: { "content-type": "application/json" }, maxTime: 120, status: false };
let url;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    if (i + 1 >= args.length) fail(`${a} bir değer bekliyor`);
    return args[++i];
  };
  if (a === "--cookie") opts.headers.cookie = `rooms_session=${val()}`;
  else if (a === "--method") opts.method = val();
  else if (a === "--max-time") opts.maxTime = Number(val());
  else if (a === "--status") opts.status = true;
  else if (a === "--header") {
    const h = val();
    const at = h.indexOf(":");
    if (at < 1) fail(`başlık "ad: değer" olmalı: ${h}`);
    opts.headers[h.slice(0, at).trim().toLowerCase()] = h.slice(at + 1).trim();
  } else if (!a.startsWith("--") && url === undefined) url = a;
  else fail(`bilinmeyen argüman: ${a}`);
}
if (!url) fail("kullanım: ... | node scripts/lib/post-json.mjs <url> [--cookie S] [--status] ...");

function fail(msg) {
  process.stderr.write(`post-json: ${msg}\n`);
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = Buffer.concat(chunks);

try {
  const res = await fetch(url, {
    method: opts.method,
    headers: opts.headers,
    body: body.length > 0 ? body : undefined,
    signal: AbortSignal.timeout(opts.maxTime * 1000),
  });
  const out = Buffer.from(await res.arrayBuffer());
  process.stdout.write(opts.status ? String(res.status) : out);
} catch (err) {
  if (opts.status) process.stdout.write("000");
  // fetch "fetch failed" der; asıl sebep (ECONNREFUSED, zaman aşımı) cause'ta.
  const cause = err instanceof Error ? err.cause : undefined;
  const why = cause?.code || cause?.message || (err instanceof Error ? err.message : String(err));
  process.stderr.write(`post-json: ${url} — ${why}\n`);
  process.exit(7);
}
