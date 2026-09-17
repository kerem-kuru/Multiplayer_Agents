import { expect, test } from "@playwright/test";

/**
 * Tarayıcı testleri — GERÇEK sunucuya ve GERÇEK agent'a karşı koşar.
 *
 * Bu ikisi kapının agent gerektiren kısmı. Anahtar/kota yoksa atlanırlar;
 * "geçti" diye işaretlenmezler.
 *
 * Çalıştırmak için:
 *   npm run api          (ANTHROPIC_API_KEY veya GEMINI_API_KEY ile)
 *   npm run dev:web
 *   npx playwright install chromium   (ilk seferde)
 *   npm run test:e2e
 */

const AGENT = process.env.E2E_AGENT ?? "backend";
/** Gemini ücretsiz katmanda 90 sn'ye kadar sürebiliyor. */
const TURN_TIMEOUT = Number(process.env.E2E_TURN_TIMEOUT ?? 180_000);

async function openNewRoom(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Yeni oda aç" }).click();
  await expect(page.getByRole("button", { name: "başlat" })).toBeVisible({ timeout: 30_000 });
}

test.describe("oda", () => {
  test("canlı izleme: görev gönder, akışta ve terminalde gör", async ({ page }) => {
    test.setTimeout(TURN_TIMEOUT + 120_000);
    await openNewRoom(page);

    await page.getByRole("button", { name: "başlat" }).click();
    // Agent hazır olunca gönderme alanı açılır.
    const box = page.getByPlaceholder(new RegExp(`${AGENT} agent`));
    await expect(box).toBeEnabled({ timeout: 60_000 });

    await box.fill("hello.js dosyası oluştur ve node ile çalıştır");
    await box.press("Enter");

    // Turn bitene kadar bekle: "çalışıyor" gidip bir sonuç gelmeli.
    await expect(page.getByText(/● (tamamlandı|bitti|başarısız)/)).toBeVisible({
      timeout: TURN_TIMEOUT,
    });

    // Etkinlik akışında dosya yazma ve kabuk komutu satırları.
    const feed = page.locator("section");
    await expect(feed.getByText(/Write|write_file/)).toBeVisible();
    await expect(feed.getByText(/Bash|run_shell_command/)).toBeVisible();

    // Terminal sekmesinde komut görünüyor.
    await page.getByRole("button", { name: "Terminal" }).click();
    await expect(page.locator(".xterm")).toContainText("node", { timeout: 15_000 });
  });

  test("yeniden yükleme: tek event kaybolmuyor, hiçbiri iki kez görünmüyor", async ({ page }) => {
    test.setTimeout(TURN_TIMEOUT + 120_000);
    await openNewRoom(page);
    await page.getByRole("button", { name: "başlat" }).click();

    const box = page.getByPlaceholder(new RegExp(`${AGENT} agent`));
    await expect(box).toBeEnabled({ timeout: 60_000 });
    await box.fill("hello.js dosyası oluştur");
    await box.press("Enter");
    await expect(page.getByText(/● (tamamlandı|bitti|başarısız)/)).toBeVisible({
      timeout: TURN_TIMEOUT,
    });

    const seqBefore = await page.getByText(/seq \d+/).innerText();
    const turnsBefore = await page.locator("section").count();

    await page.reload();

    // Yeniden yüklemede geçmiş replay edilir; sayılar AYNI olmalı.
    await expect(page.getByText(/seq \d+/)).toHaveText(seqBefore, { timeout: 30_000 });
    await expect(page.locator("section")).toHaveCount(turnsBefore);
  });
});
