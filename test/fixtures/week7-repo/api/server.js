import http from "node:http";

const orders = [
  { id: 1, total: 1250 },
  { id: 2, total: 990 },
];

http
  .createServer((req, res) => {
    if (req.url === "/api/orders") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(orders));
      return;
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(3000);
