/**
 * API hata tipi. Auth modülleri de fırlattığı için app.ts'ten ayrıldı.
 *
 * `403` "üye değilsin VEYA rolün yetmiyor VEYA böyle bir oda yok" demek:
 * var olmayan oda için 404 dönmek, oda kimliklerinin varlığını sızdırır.
 */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}
