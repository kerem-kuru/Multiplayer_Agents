/**
 * Geliştirme oturumu açar ve çerez token'ını döner.
 *
 * Magic link akışının TAMAMINI koşar: istek → token → callback → çerez.
 * Auth'u ATLATMAZ, kullanır. Sunucu `AUTH_DEV_MODE=true` ile koşuyor olmalı.
 */
export async function devSession(base, email = "gate@rooms.local") {
  const res = await fetch(`${base}/auth/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`giriş isteği başarısız (${res.status}): ${JSON.stringify(body)}`);
  if (!body.devLink) throw new Error("devLink yok — sunucu AUTH_DEV_MODE=true ile koşmuyor");

  const token = new URL(body.devLink).searchParams.get("token");
  const cb = await fetch(`${base}/auth/callback?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
  const session = /rooms_session=([^;]+)/.exec(cb.headers.get("set-cookie") ?? "")?.[1];
  if (!session) throw new Error(`oturum çerezi alınamadı (${cb.status})`);
  return session;
}

/** curl/fetch başlığı olarak hazır hâli. */
export const cookieHeader = (session) => ({ cookie: `rooms_session=${session}` });
