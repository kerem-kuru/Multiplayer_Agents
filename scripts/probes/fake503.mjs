// Google'in 503 cevabini taklit eden sahte sunucu. Her istegi sayar.
import http from "node:http";
let n = 0;
const body = JSON.stringify({
  error: {
    code: 503,
    message:
      "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
    status: "UNAVAILABLE",
  },
});
http
  .createServer((req, res) => {
    n += 1;
    process.stdout.write(`REQ ${n} ${req.method} ${req.url.split("?")[0]}\n`);
    req.resume();
    res.writeHead(503, { "content-type": "application/json" });
    res.end(body);
  })
  .listen(9999, "127.0.0.1");
