import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Hafta 7 agent kapısı — arayüzün MODEL GEREKTİREN kontrolleri.
 *
 * `scripts/week7-agent-gate.sh` içinden koşar (W7_ROOM, W7_A). Tek başına
 * koşulursa atlanır. İki turn harcar: frontend'de uzun bir kabuk komutu,
 * backend'de tek cümlelik bir cevap.
 */

const ROOM = process.env.W7_ROOM ?? "";
const A = process.env.W7_A ?? "";
const TURN_TIMEOUT = Number(process.env.W7_TURN_TIMEOUT ?? 180_000);

test.skip(!ROOM || !A, "W7_ROOM/W7_A yok — gate:w7:agent içinden koşulur");

async function as(browser: Browser, session: string): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "rooms_session", value: session, domain: "localhost", path: "/" }]);
  return ctx.newPage();
}

const card = (page: Page, name: string) => page.locator("main > button").filter({ hasText: name });

async function send(page: Page, agent: string, text: string): Promise<void> {
  const res = await page.request.post(`/api/rooms/${ROOM}/agents/${agent}/message`, {
    data: { text },
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

test("17-18) agent koşarken oda görünümünde tool özeti var, ham çıktı yok", async ({ browser }) => {
  const a = await as(browser, A);
  await a.goto(`/rooms/${ROOM}`);
  await expect(card(a, "frontend")).toHaveCount(1);

  // `sleep` tool çağrısını açık tutar: kart satırı o sırada tool özeti olmalı.
  await send(a, "frontend", "Kabukta tam olarak şu komutu çalıştır: sleep 25 && ls web. Başka bir şey yapma.");

  // lineKind "tool" → satır monospace (.mono). Özet "Araç · girdi" biçiminde.
  const toolLine = card(a, "frontend").locator(".mono");
  await expect(toolLine).toBeVisible({ timeout: TURN_TIMEOUT });
  await expect(toolLine).toContainText("·");
  await expect(card(a, "frontend")).toContainText("çalışıyor");

  // Koşarken: xterm yok, <pre> yok, tool SONUCU yok (ls çıktısı index.html içerirdi).
  await expect(a.locator(".xterm")).toHaveCount(0);
  await expect(a.locator("pre")).toHaveCount(0);
  await expect(a.locator("main")).not.toContainText("index.html");
});

test("21) bakılmayan agent'ın turn'ü bitince okunmamış; detay açılınca 10 sn içinde sönüyor", async ({
  browser,
}) => {
  const a = await as(browser, A);
  await a.goto(`/rooms/${ROOM}`);
  await expect(card(a, "backend")).toHaveCount(1);
  // Önceki turn'lerden kalan işareti temizle: detayı aç, seen gönderilsin.
  await card(a, "backend").click();
  await a.waitForTimeout(7_000);
  await a.goBack();
  await expect(card(a, "backend")).not.toContainText("yeni etkinlik", { timeout: 10_000 });

  await send(a, "backend", "Tek cümleyle cevap ver: hazır mısın? Hiçbir araç kullanma.");
  await expect(card(a, "backend")).toContainText("yeni etkinlik", { timeout: TURN_TIMEOUT });

  const opened = Date.now();
  await card(a, "backend").click();
  await expect(a).toHaveURL(/\/agents\/backend\/ozet$/);
  // seen çağrısı 5 sn debounce'lu; sonra odaya dön ve işaretin söndüğünü gör.
  await a.waitForTimeout(6_000);
  await a.goBack();
  await expect(card(a, "backend")).not.toContainText("yeni etkinlik", {
    timeout: Math.max(1_000, 10_000 - (Date.now() - opened)),
  });
});
