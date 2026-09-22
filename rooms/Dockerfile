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
# `apt-get upgrade`: dagitimin git guvenlik yamalari HER imaj build'inde
# alinsin. Debian yamalari surum numarasini degistirmeden geri tasidigi icin
# "surum >= X" kontrolu yaniltici olur; guncel kalmanin yolu upgrade etmek.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
      git \
      bash \
      ca-certificates \
      ripgrep \
      curl \
      procps \
      passwd \
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

# gitkit — checkpoint ve diff mantığı (Hafta 6).
#
# Dış bağımlılığı yok, `npm install` gerekmiyor. Sunucu bunu
# `docker exec node /opt/runner/gitkit/dist/gitkit.js <komut>` ile çağırır;
# runner ise aynı kodu kendi bundle'ının içinde taşır. HOST'TA GİT ÇALIŞMAZ:
# agent `.git/config` ve hook dosyalarına yazabiliyor, host'ta koşan bir git
# onları tetikleyip host'ta kod çalıştırabilirdi.
WORKDIR /opt/runner/gitkit
COPY packages/gitkit/bundle/gitkit.js ./dist/gitkit.js

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

# safe.directory — TEK BIR YOL icin, sistem duzeyinde.
#
# Degismez Kural 9 `safe.directory=*` yasakliyor ve o yasak duruyor. Ama Hafta
# 7 mimarisi merkez depoyu `rooms-integrator`a veriyor ve her agent ondan
# `git clone --shared` ile kendi deposunu aliyor. Git'in sahiplik kontrolu
# (depo sahibi != komutu koşan kullanici) klonu reddediyor.
#
# Istisna komut satirindan VERILEMIYOR: git `safe.directory`yi yalnizca
# korumali config'ten (sistem/global) okur, `-c` ile verileni bilerek yok
# sayar — bir depo kendini beyaz listeye alamasin diye. Olculdu:
#   duz klon            -> dubious ownership
#   -c safe.directory   -> dubious ownership (yok sayiliyor)
#   sistem duzeyi       -> calisiyor
#
# Neden guvenli: `*` "her depoya guven" demek; bu satir "su tek depoya guven"
# diyor ve o deponun agent tarafindan YAZILAMAZ oldugu izin matrisinde ayrica
# olculuyor (repo.git/config, hooks/, refs/ -> Permission denied). Guvenilen
# sey, agent'in degistiremedigi bir depo. Dosya /etc/gitconfig root'a ait,
# agent oraya yazamaz.
#
# Agent'larin KENDI depolari icin istisna YOK: onlar zaten kendi sahipleri.
RUN git config --system safe.directory /room/repo.git

# /room BOS kalir ve imajda hicbir sey tohumlanmaz.
#
# Hafta 7'den beri /room bir named volume. Docker, bos bir volume'u ilk
# baglayista imajdaki ayni yolun icerigiyle TOHUMLAR — burada klasor yaratip
# `agent`e verseydik volume yanlis sahiplikte baslardi. Klasorleri izin
# plani yaratiyor (packages/core/src/room-fs.ts), dogru sahip ve modla.
WORKDIR /room

USER agent

# Oda ayakta durur, agent süreçleri sunucu tarafından exec ile başlatılır.
CMD ["sleep", "infinity"]
