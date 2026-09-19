# Oda imajı — bir oda = bu imajdan bir container, içinde N agent süreci.
#
# Agent süreçleri `docker exec` ile başlatılır; PID 1 hiçbir iş yapmaz.
# SDK'nın native binary'si container'ın platformuna göre BURADA kurulur —
# host'tan node_modules kopyalanırsa (ör. Apple Silicon host, linux/amd64
# container) yanlış binary gelir.

FROM node:22-bookworm-slim

# Ortamdaki alet çantası. Agent container İÇİNDE her şeyi yapabilir ama
# sistem paketi KURAMAZ (apt root ister, agent root değil). Yani buraya
# koymadığımız bir dil/araç, agent için YOK demektir.
#
# Gerçekte oldu: "Django ile blog yaz" görevinde agent doğru davranıp durdu —
# ortamda Python yoktu. Yetki sınırı değil, kurulum sınırıydı.
#
# Buradaki liste `ROOM_TOOLCHAIN_PROBES` ile eşleşir (packages/protocol/
# src/prompts.ts): runner başlangıçta bunların sürümünü ÖLÇÜP agent'a
# söylüyor, yani liste ile gerçek arasında kayma olamaz.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      bash \
      ca-certificates \
      ripgrep \
      curl \
      procps \
      python3 \
      python3-venv \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# Agent root olarak koşmaz. Container sınırı bir güvenlik katmanı,
# dosya izni ikincisi.
RUN useradd --create-home --shell /bin/bash agent

# Koşum ortamları YAN YANA kurulur. Rol YAML'ındaki `runtime` alanı hangisinin
# çalışacağını seçer; biri diğerini etkilemez.
#
# Sadece dist/package.json kopyalanır: katman önbelleği runner kodu değişince
# alttaki CLI/SDK'yı yeniden kurmasın.

# Claude Agent SDK
WORKDIR /opt/runner/claude
COPY packages/runner/dist/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force
COPY packages/runner/dist/runner.js ./dist/runner.js

# Gemini CLI
WORKDIR /opt/runner/gemini
COPY packages/runner-gemini/dist/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force
COPY packages/runner-gemini/dist/runner.js ./dist/runner.js

RUN chown -R agent:agent /opt/runner

# Python: HAZIR BİR VENV, PATH'in başında.
#
# Debian'da sistem python'una `pip install` yasak (PEP 668,
# "externally-managed-environment"). Bunu her turn'de agent'a çözdürmek
# tekrar eden bir engel olurdu; venv önceden kuruluyor ve agent'a ait, yani
# `pip install django` doğrudan çalışıyor.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && chown -R agent:agent /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /room
RUN mkdir -p /room/worktrees /room/contracts /room/journal \
    && chown -R agent:agent /room

USER agent

# Oda ayakta durur, agent süreçleri sunucu tarafından exec ile başlatılır.
CMD ["sleep", "infinity"]
