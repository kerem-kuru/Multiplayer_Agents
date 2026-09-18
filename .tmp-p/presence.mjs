import { chromium } from "@playwright/test";
const TUNNEL = "https://continue-accounting-masters-unfortunately.trycloudflare.com";
const b = await chromium.launch();

async function login(ctx, base, email) {
  const p = await ctx.newPage();
  await p.goto(base + "/");
  await p.getByPlaceholder("sen@ornek.com").fill(email);
  await p.getByRole("button", { name: "Bağlantı gönder" }).click();
  await p.locator("a[href*='token=']").click();
  await p.waitForTimeout(2000);
  return p;
}

// A: oda sahibi, LOCALHOST
const a = await login(await b.newContext(), "http://localhost:5173", `sahip-${Date.now()}@rooms.local`);
await a.getByRole("button", { name: "Yeni oda aç" }).click();
await a.waitForTimeout(6000);
console.log("A oda acti:", a.url());
await a.getByRole("button", { name: "Paylaş" }).click();
await a.getByRole("button", { name: "Paylaşım linki oluştur" }).click();
const inviteUrl = await a.locator("input[readonly]").inputValue();
await a.getByRole("button", { name: "Kapat" }).click();
console.log("davet linki tunelde mi:", inviteUrl.startsWith(TUNNEL));

// B: izleyici, TUNEL uzerinden
const ctxB = await b.newContext();
const bp = await login(ctxB, TUNNEL, `izleyici-${Date.now()}@rooms.local`);
await bp.goto(inviteUrl);
await bp.waitForTimeout(6000);
console.log("B odada mi:", bp.url().includes("room="));

await a.waitForTimeout(4000);
const bodyA = await a.textContent("body");
const bodyB = await bp.textContent("body");
console.log("A ekraninda:", /(\d+) kişi/.exec(bodyA)?.[0] ?? "KISI YAZISI YOK");
console.log("B ekraninda:", /(\d+) kişi/.exec(bodyB)?.[0] ?? "KISI YAZISI YOK");
console.log("A baglanti durumu:", /seq \d+ · (\w+)/.exec(bodyA)?.[1] ?? "?");
console.log("B baglanti durumu:", /seq \d+ · (\w+)/.exec(bodyB)?.[1] ?? "?");
await a.screenshot({ path: "C:/Users/KEREM/AppData/Local/Temp/claude/p-a.png" });
await bp.screenshot({ path: "C:/Users/KEREM/AppData/Local/Temp/claude/p-b.png" });
await b.close();
