# Oda imajı — bir oda = bu imajdan bir container, içinde N agent süreci.
#
# Agent süreçleri `docker exec` ile başlatılır; PID 1 hiçbir iş yapmaz.
# SDK'nın native binary'si container'ın platformuna göre BURADA kurulur —
# host'tan node_modules kopyalanırsa (ör. Apple Silicon host, linux/amd64
# container) yanlış binary gelir.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      bash \
      ca-certificates \
      ripgrep \
      curl \
      procps \
    && rm -rf /var/lib/apt/lists/*

# Agent root olarak koşmaz. Container sınırı bir güvenlik katmanı,
# dosya izni ikincisi.
RUN useradd --create-home --shell /bin/bash agent

# Runner ve SDK. Sadece dist/package.json kopyalanır: katman önbelleği
# runner kodu değişince SDK'yı yeniden kurmasın.
WORKDIR /opt/runner
COPY packages/runner/dist/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force
COPY packages/runner/dist/runner.js ./dist/runner.js
RUN chown -R agent:agent /opt/runner

WORKDIR /room
RUN mkdir -p /room/worktrees /room/contracts /room/journal \
    && chown -R agent:agent /room

USER agent

# Oda ayakta durur, agent süreçleri sunucu tarafından exec ile başlatılır.
CMD ["sleep", "infinity"]
