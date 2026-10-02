// MODE=503: Google'in "high demand" 503'u. MODE=429: dakikalik kota 429'u (RetryInfo 3s).
import http from "node:http";
const MODE = process.env.MODE || "503";
let n = 0;
const b503 = { error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", status: "UNAVAILABLE" } };
const b429 = { error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.5-flash\nPlease retry in 3.146378666s.", status: "RESOURCE_EXHAUSTED",
  details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaDimensions: { model: "gemini-3.5-flash", location: "global" }, quotaValue: "5" }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" } ] } };
http.createServer((req, res) => {
  n += 1; process.stdout.write(`REQ ${n} ${req.url.split("?")[0]}\n`); req.resume();
  const code = MODE === "429" ? 429 : 503;
  res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(code === 429 ? b429 : b503));
}).listen(9999, "127.0.0.1");
