import { chromium } from "@playwright/test";
const TUNNEL = "http://localhost:5173";
const b = await chromium.launch();
const ctx = await b.newContext();
const p = await ctx.newPage();
p.on("console", (m) => { if (m.type() === "error") console.log("KONSOL HATA:", m.text().slice(0, 160)); });

await p.goto(TUNNEL + "/");
await p.getByPlaceholder("sen@ornek.com").fill(`istemci-${Date.now()}@rooms.local`);
await p.getByRole("button", { name: "Bağlantı gönder" }).click();
await p.locator("a[href*='token=']").click();
await p.waitForTimeout(2000);
await p.getByRole("button", { name: "Yeni oda aç" }).click();
await p.waitForTimeout(6000);
const roomId = new URL(p.url()).searchParams.get("room");
console.log("oda:", roomId);

// Ham EventSource: tarayici presence frame'ini goruyor mu?
const seen = await p.evaluate(async (room) => {
  return await new Promise((resolve) => {
    const types = {};
    const es = new EventSource(`/api/rooms/${room}/events?since=0`);
    const count = (t) => (types[t] = (types[t] ?? 0) + 1);
    es.addEventListener("events", () => count("events"));
    es.addEventListener("presence", (e) => { count("presence"); types.ornek = e.data.slice(0, 90); });
    es.addEventListener("open", () => count("open"));
    es.onmessage = () => count("message(varsayilan)");
    setTimeout(() => { es.close(); resolve(types); }, 6000);
  });
}, roomId);
console.log("tarayicinin gordugu frame tipleri:", JSON.stringify(seen, null, 2));
await b.close();
