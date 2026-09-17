# Oda imajı — bir oda = bu imajdan bir container, içinde N agent süreci.
#
# Hafta 1'de içinde agent koşmuyor; sadece klasör düzeni, git ve node var.
# Hafta 2'de Claude Agent SDK buraya girer.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      ripgrep \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Agent root olarak koşmaz. Container sınırı bir güvenlik katmanı,
# dosya izni ikincisi.
RUN useradd --create-home --shell /bin/bash agent

WORKDIR /room
RUN mkdir -p /room/worktrees /room/contracts /room/journal \
    && chown -R agent:agent /room

USER agent

# Oda ayakta durur, agent süreçleri sunucu tarafından exec ile başlatılır.
CMD ["sleep", "infinity"]
