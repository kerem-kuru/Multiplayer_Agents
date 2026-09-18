import { chromium } from "@playwright/test";
const BASE = "http://localhost:5173";
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
p.on("response", (r) => { if (r.url().includes("/events")) console.log("AG:", r.status(), r.url().replace(BASE, ""), r.headers()["content-type"]); });

await p.goto(BASE + "/");
await p.getByPlaceholder("sen@ornek.com").fill(`istemci2-${Date.now()}@rooms.local`);
await p.getByRole("button", { name: "Bağlantı gönder" }).click();
await p.locator("a[href*='token=']").click();
await p.waitForTimeout(2000);
await p.getByRole("button", { name: "Yeni oda aç" }).click();
await p.waitForTimeout(6000);
const roomId = new URL(p.url()).searchParams.get("room");

const out = await p.evaluate(async (room) => {
  return await new Promise((resolve) => {
    const log = [];
    const es = new EventSource(`/api/rooms/${room}/events?since=0`);
    es.addEventListener("presence", (e) => log.push("presence " + e.data.slice(0, 60)));
    es.addEventListener("events", (e) => log.push("events " + e.data.slice(0, 40)));
    es.onopen = () => log.push("onopen readyState=" + es.readyState);
    es.onerror = () => log.push("onerror readyState=" + es.readyState);
    setTimeout(() => { log.push("son readyState=" + es.readyState); es.close(); resolve(log); }, 7000);
  });
}, roomId);
console.log(out.join("\n"));
await b.close();
