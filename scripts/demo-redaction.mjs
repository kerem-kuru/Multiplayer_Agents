/**
 * Redaction'ı EKRANDA görmek için — agent gerekmeden.
 *
 *   node scripts/demo-redaction.mjs <roomId> [--base http://localhost:8787]
 *
 * Odaya, agent'ın `cat .env` çıktısıymış gibi görünen bir `tool.result`
 * event'i yazar. Değerlerin hepsi SAHTE ama formatları gerçek. Tarayıcıda oda
 * açıksa satır anında düşer ve maskelenmiş hâlde görünür:
 *
 *   ANTHROPIC_API_KEY=[redacted:anthropic-api-key:6c1f9a2b]
 *
 * Yanına bilerek maskelenmemesi gereken şeyler de konur (git sha, UUID, uzun
 * yol, port): dogfood'un "redaction gereksiz yere bir şey maskeledi mi"
 * sorusunu ekrana bakarak cevaplayabilmek için.
 */
import { devSession } from "./dev-session.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const roomId = process.argv[2];
if (!roomId || roomId.startsWith("--")) {
  console.error("kullanım: node scripts/demo-redaction.mjs <roomId> [--base http://localhost:8787]");
  process.exit(1);
}

const base = arg("base", "http://localhost:8787");
const email = arg("email", "");

// Oturum: verilmişse ortamdan, yoksa geliştirme girişi aç.
const session = process.env.ROOMS_SESSION || (await devSession(base, email || "demo@rooms.local"));
const headers = { "content-type": "application/json", cookie: `rooms_session=${session}` };

const room = await (await fetch(`${base}/rooms/${roomId}`, { headers })).json();
if (!room.room) {
  console.error(`odaya erişilemedi: ${JSON.stringify(room)}`);
  console.error("bu oturum odanın üyesi mi? ROOMS_SESSION ile kendi çerezini verebilirsin.");
  process.exit(1);
}

const sessions = await (await fetch(`${base}/rooms/${roomId}/events?since=0&limit=1`, { headers })).json();
const sessionId = sessions.sessionId;

// SAHTE değerler — formatları gerçek, hiçbiri bir hesaba ait değil.
const fake = (...parts) => parts.join("");
const lines = [
  "$ cat .env",
  `ANTHROPIC_API_KEY=${fake("sk-ant-", "api03-DemoFakeKeyAbCdEfGhIjKlMn")}`,
  `AWS_ACCESS_KEY_ID=${fake("AKIA", "IOSFODNN7EXAMPLE")}`,
  `AWS_SECRET_ACCESS_KEY=${fake("wJalrXUtnFEMI/", "K7MDENG/bPxRfiCYEXAMPLEKEY")}`,
  "DB_PASSWORD=demo-fake-password-9xQ",
  `SESSION_SECRET=${fake("Zt9xQv2LmNpR4sT7", "uWyA3bCdEfGhJkLmNpQrStUv")}`,
  "PORT=8787",
  "",
  "# Bunlar MASKELENMEMELİ — yanlış pozitif kontrolü:",
  "commit 9f2a1c4e7b8d3a5f6e0c9b2d4a7f1e8c3b6d5a09",
  "roomId 3437e583-ca04-4f96-a9ef-817e6111a371",
  "dosya /room/worktrees/backend/node_modules/@agent-rooms/protocol/dist/index.js",
  "sürüm 2.11.0-rc.4+build.20260918",
].join("\n");

const res = await fetch(`${base}/sessions/${sessionId}/events`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    type: "tool.result",
    payload: {
      agent: arg("agent", "backend"),
      messageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      toolUseId: `demo-${Date.now()}`,
      isError: false,
      truncated: false,
      output: lines,
    },
  }),
});

const written = await res.json();
if (!res.ok) {
  console.error(`event yazılamadı (${res.status}): ${JSON.stringify(written)}`);
  process.exit(1);
}

console.log(`yazıldı: seq ${written.seq}`);
console.log("");
console.log("--- log'a NE girdi (yani ekranda ne göreceksin) ---");
console.log(written.payload.output);
