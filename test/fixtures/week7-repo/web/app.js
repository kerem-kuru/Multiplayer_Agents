import { formatPrice } from "../src/shared.js";

const res = await fetch("/api/orders");
const orders = await res.json();
document.getElementById("orders").innerHTML = orders
  .map((o) => `<li>${o.id} — ${formatPrice(o.total)}</li>`)
  .join("");
