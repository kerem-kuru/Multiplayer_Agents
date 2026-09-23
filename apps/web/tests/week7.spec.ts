import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Hafta 7 kapısı — arayüz kontrolleri (MODEL İSTEĞİ HARCAMAZ).
 *
 * `scripts/week7-gate.sh` odaları açar, iki oturum çerezini üretir ve bu
 * dosyayı ortam değişkenleriyle koşar. Tek başına koşulursa atlanır —
 * "geçti" diye işaretlenmez.
 *
 * Model gerektiren arayüz kontrolleri (koşarken tool özeti, okunmamış işareti)
 * `gate:w7:agent` içinde.
 */

const ROOM = process.env.W7_ROOM ?? "";
const ROOM3 = process.env.W7_ROOM3 ?? "";
const A = process.env.W7_A ?? "";
const B = process.env.W7_B ?? "";
const B_NAME = process.env.W7_B_NAME ?? "";

test.skip(!ROOM || !A || !B, "W7_ROOM/W7_A/W7_B yok — gate:w7 içinden koşulur");

async function as(browser: Browser, session: string): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "rooms_session", value: session, domain: "localhost", path: "/" }]);
  return ctx.newPage();
}

const cards = (page: Page) => page.locator("main > button");
const card = (page: Page, name: string) => cards(page).filter({ hasText: name });

test("16) kart sayısı config'teki agent sayısına eşit (2 ve 3)", async ({ browser }) => {
  const a = await as(browser, A);
  await a.goto(`/rooms/${ROOM}`);
  await expect(cards(a)).toHaveCount(2);
  await expect(card(a, "frontend")).toHaveCount(1);
  await expect(card(a, "backend")).toHaveCount(1);

  test.skip(!ROOM3, "üç agent'lı oda yok");
  await a.goto(`/rooms/${ROOM3}`);
  await expect(cards(a)).toHaveCount(3);
  await expect(card(a, "security")).toHaveCount(1);
});

test("17) oda görünümünde terminal ve ham çıktı yok", async ({ browser }) => {
  const a = await as(browser, A);
  await a.goto(`/rooms/${ROOM}`);
  await expect(cards(a)).toHaveCount(2);
  await expect(a.locator(".xterm")).toHaveCount(0);
  await expect(a.locator("pre")).toHaveCount(0);
});

test("19) karta tıklayınca detay açılıyor, varsayılan sekme Özet; geri düğmesi odaya döner", async ({
  browser,
}) => {
  const a = await as(browser, A);
  await a.goto(`/rooms/${ROOM}`);
  await card(a, "frontend").click();
  await expect(a).toHaveURL(new RegExp(`/rooms/${ROOM}/agents/frontend/ozet$`));
  await expect(a.getByRole("tab", { name: "Özet" })).toHaveAttribute("aria-selected", "true");

  await a.goBack();
  await expect(a).toHaveURL(new RegExp(`/rooms/${ROOM}$`));
  await expect(cards(a)).toHaveCount(2);
});

test("19b) kart klavyeyle açılıyor (Enter)", async ({ browser }) => {
  const a = await as(browser, A);
  await a.goto(`/rooms/${ROOM}`);
  await card(a, "backend").focus();
  await a.keyboard.press("Enter");
  await expect(a).toHaveURL(new RegExp(`/agents/backend/ozet$`));
});

test("20) B frontend detayındayken A'nın odasında frontend kartında B görünüyor", async ({
  browser,
}) => {
  const b = await as(browser, B);
  await b.goto(`/rooms/${ROOM}/agents/frontend/ozet`);
  await expect(b.getByRole("tab", { name: "Özet" })).toBeVisible();

  const a = await as(browser, A);
  await a.goto(`/rooms/${ROOM}`);
  await expect(card(a, "frontend")).toContainText(`şu an bakanlar: ${B_NAME}`, { timeout: 20_000 });
  // Bakılmayan kartta B yok.
  await expect(card(a, "backend")).not.toContainText(B_NAME);
});
