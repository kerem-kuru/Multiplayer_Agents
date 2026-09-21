/**
 * Sipariş işleme — kapı testinin inceleme konusu.
 *
 * Bu fonksiyon BİLEREK üç işi birden yapıyor: doğrular, hesaplar, kaydeder.
 * Kapı testinde bir insan buranın ilk satırına "bunu böl" yorumu bırakır ve
 * agent'ın 60 saniye içinde fonksiyonu ayırmasını bekleriz. Düzgün yazılmış
 * olsaydı ölçecek bir şey kalmazdı.
 */

const TAX_RATE = 0.2;
const FREE_SHIPPING_OVER = 500;
const SHIPPING_FLAT = 29.9;

function processOrder(order, db) {
  if (!order) throw new Error("sipariş yok");
  if (!Array.isArray(order.items) || order.items.length === 0) {
    throw new Error("sipariş boş");
  }
  for (const item of order.items) {
    if (typeof item.price !== "number" || item.price < 0) {
      throw new Error(`geçersiz fiyat: ${item.sku}`);
    }
    if (!Number.isInteger(item.qty) || item.qty <= 0) {
      throw new Error(`geçersiz adet: ${item.sku}`);
    }
  }
  if (!order.customer || !order.customer.email) {
    throw new Error("müşteri e-postası yok");
  }

  let subtotal = 0;
  for (const item of order.items) {
    subtotal += item.price * item.qty;
  }
  const discount = order.coupon === "ILK10" ? subtotal * 0.1 : 0;
  const taxed = (subtotal - discount) * (1 + TAX_RATE);
  const shipping = taxed >= FREE_SHIPPING_OVER ? 0 : SHIPPING_FLAT;
  const total = Math.round((taxed + shipping) * 100) / 100;

  const row = {
    email: order.customer.email,
    subtotal,
    discount,
    shipping,
    total,
    createdAt: new Date().toISOString(),
  };
  db.insert("orders", row);
  return row;
}

module.exports = { processOrder };
