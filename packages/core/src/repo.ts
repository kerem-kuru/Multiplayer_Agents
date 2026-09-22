import type { RoomConfig } from "@agent-rooms/protocol";
import { branchName } from "@agent-rooms/protocol";
import { execCapture } from "./agents/exec.js";
import { getDocker, roomVolumeName, shortRoomId, toDockerPath } from "./docker/container.js";
import { INTEGRATOR, agentUser } from "./room-fs.js";

/**
 * Hafta 7, Adım 4 — merkez depo ve agent klonları.
 *
 * **Karar 3: `git worktree` DEĞİL, `git clone --shared`.**
 *
 * `git worktree`de bütün çalışma ağaçları TEK bir `.git` paylaşır: nesneler,
 * ref'ler, `config` ve hook'lar ortak. Bir agent'ın commit atabilmesi için o
 * ortak alana yazma yetkisi gerekir ve o yetkiyle diğerinin branch'ini
 * silebilir ya da ortak `config`e hook ekleyip diğerinin git komutlarında kod
 * çalıştırabilir. Bu, haftanın amacını doğrudan bozar.
 *
 * `clone --shared` her agent'a kendine ait, sadece onun yazabildiği bir `.git`
 * verir; nesneleri merkezden salt okunur ödünç alır (disk maliyeti yok).
 *
 * **Kararın bedeli:** alternates ile gc birbirini sevmez. `--shared` klonlar
 * merkezdeki nesneleri ödünç aldığı için merkezde bir gc/prune ya da geçmiş
 * yeniden yazma olursa klonlar SESSİZCE bozulur. Önlem `hardenCentralRepo`:
 * otomatik gc kapalı, prune süresi `never`, silme ve fast-forward olmayan
 * güncellemeler reddedilir, taban commit ayrı bir korumalı ref ile her zaman
 * erişilebilir tutulur.
 *
 * **MERKEZDE GEÇMİŞ YENİDEN YAZILMAZ.** Bu dosyada `gc --prune=now`,
 * `repack -a -d`, branch silme veya force güncelleme yapan kod YOKTUR ve
 * yazılmayacaktır.
 */

/** Integrator komutları: dosyalar 0644, dizinler 0755 olsun diye. */
const INTEGRATOR_UMASK = "umask 022";

/** `commit-tree` yazar/committer ister. */
const IDENT = [
  "GIT_AUTHOR_NAME=agent-rooms",
  "GIT_AUTHOR_EMAIL=rooms@localhost",
  "GIT_COMMITTER_NAME=agent-rooms",
  "GIT_COMMITTER_EMAIL=rooms@localhost",
].join(" ");

export const CENTRAL_REPO = "/room/repo.git";

export class RepoError extends Error {
  constructor(step: string, detail: string) {
    super(`depo kurulumu başarısız (${step}): ${detail.trim().slice(0, 500)}`);
    this.name = "RepoError";
  }
}

/** Container içinde bir kabuk komutunu belirtilen kullanıcıyla koşar. */
async function sh(
  container: string,
  user: string,
  cmd: string,
  step: string,
  timeoutMs = 180_000,
): Promise<string> {
  const res = await execCapture({ container, user, cmd: ["sh", "-c", cmd], timeoutMs });
  if (res.exitCode !== 0) throw new RepoError(step, res.stderr || res.stdout);
  return res.stdout.trim();
}

/**
 * Merkez depoyu sertleştirir.
 *
 * Oda her başlatıldığında YENİDEN uygulanır: biri elle değiştirse bile geri
 * gelsin. Klonlar merkezdeki nesnelere bağımlı olduğu için bu ayarlar
 * izolasyonun değil, VERİ BÜTÜNLÜĞÜNÜN koruması.
 */
export async function hardenCentralRepo(
  container: string,
  roomId: string,
  baseSha: string,
): Promise<void> {
  const short = shortRoomId(roomId);
  const cfg = [
    "gc.auto 0",
    "gc.autoDetach false",
    "gc.pruneExpire never",
    "gc.reflogExpire never",
    "gc.reflogExpireUnreachable never",
    "core.logAllRefUpdates always",
    "receive.denyDeletes true",
    "receive.denyNonFastForwards true",
  ]
    .map((pair) => `git -C ${CENTRAL_REPO} config ${pair}`)
    .join(" && ");

  // refs/rooms/base/* taban commit'ini ve TÜM atalarını her koşulda erişilebilir
  // tutar: `main` ileride değişse bile klonların dayandığı nesneler budanamaz.
  const protect = `git -C ${CENTRAL_REPO} update-ref refs/rooms/base/${short} ${baseSha}`;
  await sh(container, INTEGRATOR, `${INTEGRATOR_UMASK} && ${cfg} && ${protect}`, "sertleştirme");
}

/** `ref`in çözüldüğü sha — taban commit. */
async function resolveSha(container: string, ref: string): Promise<string> {
  const out = await sh(
    container,
    INTEGRATOR,
    `git -C ${CENTRAL_REPO} rev-parse --verify "${ref}^{commit}"`,
    "taban çözümleme",
    60_000,
  );
  return out.split(/\s+/)[0] ?? "";
}

export interface CentralRepoResult {
  source: "empty" | "local" | "git";
  baseRef: string;
  baseSha: string;
}

/**
 * Merkez depoyu kurar. İzin planı uygulandıktan SONRA çağrılır.
 *
 * Her yol `rooms-integrator` kullanıcısıyla koşar — root ile değil (Değişmez
 * Kural 11: ayrıcalıklı bir kimlik bir agent'ın deposunu asla git deposu
 * olarak açmaz; merkez depo da ayrıcalık gerektirmiyor).
 */
export async function initCentralRepo(opts: {
  container: string;
  roomId: string;
  config: RoomConfig;
  image: string;
}): Promise<CentralRepoResult> {
  const { container, roomId, config, image } = opts;
  const repo = config.repo;

  if (repo.kind === "empty") {
    // Boş depo + TEK boş başlangıç commit'i. Çalışma ağacı gerekmiyor:
    // `mktree` boş ağacı, `commit-tree` onun commit'ini üretiyor.
    const script = [
      INTEGRATOR_UMASK,
      `git init --bare --initial-branch=main ${CENTRAL_REPO} >/dev/null`,
      `TREE=$(git -C ${CENTRAL_REPO} mktree </dev/null)`,
      `COMMIT=$(${IDENT} git -C ${CENTRAL_REPO} commit-tree $TREE -m "oda tabanı")`,
      `git -C ${CENTRAL_REPO} update-ref refs/heads/main $COMMIT`,
      "echo $COMMIT",
    ].join(" && ");
    const baseSha = (await sh(container, INTEGRATOR, script, "boş depo")).split(/\s+/).pop() ?? "";
    await hardenCentralRepo(container, roomId, baseSha);
    return { source: "empty", baseRef: "main", baseSha };
  }

  if (repo.kind === "git") {
    await sh(
      container,
      INTEGRATOR,
      `${INTEGRATOR_UMASK} && git clone --bare --no-recurse-submodules ${repo.url} ${CENTRAL_REPO}`,
      "uzak depo klonu",
      600_000,
    );
    const baseSha = await resolveSha(container, repo.ref);
    await hardenCentralRepo(container, roomId, baseSha);
    return { source: "git", baseRef: repo.ref, baseSha };
  }

  /*
   * local: kaynak yol ANA oda container'ına BAĞLANMAZ.
   *
   * Geçici ikinci bir container açılır; kaynağı salt okunur, oda volume'unu
   * yazılabilir görür. Böylece agent'ların yaşadığı container host'taki
   * hiçbir yolu hiç görmez.
   */
  await runInTempContainer({
    image,
    roomId,
    hostSource: repo.path,
    /*
     * `safe.directory` /src için: bind mount ile gelen dosyalar host'un
     * uid'ini taşır ve klonlayan kullanıcıyla (9000) eşleşmez; git sahiplik
     * kontrolüyle durur.
     *
     * İstisna bu KULLAN-AT container'ın kendi HOME'unda kalıyor: container
     * saniyeler sonra siliniyor, ağı kapalı, kaynağı salt okunur görüyor ve
     * yol operatörün `ROOMS_SOURCE_ROOT` ile açıkça izin verdiği yer. Oda
     * container'ına ve agent'lara hiçbir şey sızmıyor.
     *
     * `--no-local`: kaynak aynı dosya sisteminde olsa bile sert link kurmasın.
     * Sert link, merkez deponun nesnelerini host'taki depoya bağlardı.
     */
    cmd:
      `export HOME=/tmp && ${INTEGRATOR_UMASK} && ` +
      `git config --global --add safe.directory /src && ` +
      `git config --global --add safe.directory /src/.git && ` +
      `git clone --bare --no-local --no-recurse-submodules /src ${CENTRAL_REPO}`,
  });

  const baseSha = await resolveSha(container, repo.ref);
  await hardenCentralRepo(container, roomId, baseSha);
  return { source: "local", baseRef: repo.ref, baseSha };
}

/**
 * Kaynağı salt okunur gören, oda volume'unu yazan kısa ömürlü container.
 *
 * Kullanıcı İSİMLE değil UID ile veriliyor: `useradd` ana container'ın
 * `/etc/passwd`'sine yazıldı ve o dosya volume'de DEĞİL. Geçici container o
 * isimleri bilmez; sahiplik zaten uid ile tutulduğu için `9000:9000` aynı
 * sonucu verir.
 */
async function runInTempContainer(opts: {
  image: string;
  roomId: string;
  hostSource: string;
  cmd: string;
}): Promise<void> {
  const docker = getDocker();
  const c = await docker.createContainer({
    Image: opts.image,
    User: "9000:9000",
    Cmd: ["sh", "-c", opts.cmd],
    HostConfig: {
      Mounts: [
        { Type: "volume", Source: roomVolumeName(opts.roomId), Target: "/room" },
        { Type: "bind", Source: toDockerPath(opts.hostSource), Target: "/src", ReadOnly: true },
      ],
      // Yerel bir depoyu klonlamak için ağ gerekmiyor; kapatmak, kaynaktaki
      // bir git config'inin dışarı bağlanmasını da engeller.
      NetworkMode: "none",
    },
  });
  try {
    await c.start();
    const res = await c.wait();
    if (res.StatusCode !== 0) {
      const logs = await c.logs({ stdout: true, stderr: true, tail: 40 });
      throw new RepoError("yerel depo klonu", String(logs));
    }
  } finally {
    await c.remove({ force: true }).catch(() => undefined);
  }
}

export interface AgentClone {
  agent: string;
  branch: string;
}

/**
 * Her agent için kendi deposunu klonlar — O AGENT'IN KULLANICISIYLA.
 *
 * Root ile yapılsaydı `.git` altında root'a ait dosyalar kalır ve agent'ın ilk
 * git komutu düşerdi. Daha önemlisi Değişmez Kural 3: bir agent'ın deposunda
 * çalışan her işlem o agent'ın kimliğiyle çalışır.
 */
export async function cloneForAgents(opts: {
  container: string;
  roomId: string;
  config: RoomConfig;
  baseSha: string;
}): Promise<AgentClone[]> {
  const { container, roomId, config, baseSha } = opts;
  const short = shortRoomId(roomId);
  const out: AgentClone[] = [];

  for (const a of config.agents) {
    const dir = `/room/${a.workspace}`;
    const branch = branchName(short, a.name);
    /*
     * `core.hooksPath=/dev/null`: merkez depodan gelen bir hook çalışmasın.
     * `protocol.file.allow=always`: gitkit'in genel yasağı (`never`) burada
     *   geçerli olamaz — `clone --shared` zaten yerel bir yoldan okuyor.
     *   Yasak uzak bir sunucunun bizi yerel yola yönlendirmesine karşı; burada
     *   yolu BİZ veriyoruz ve sabit.
     * `--no-checkout`: önce branch'i açıp sonra dolduruyoruz.
     *
     * Merkez depo `rooms-integrator`a ait, agent ise başka bir kullanıcı;
     * git'in sahiplik kontrolü bu yüzden klonu reddeder. İstisna BURADA
     * verilemiyor: git `safe.directory`yi yalnızca korumalı config'ten
     * (sistem/global) okur, `-c` ile verileni bilerek yok sayar — ki bir depo
     * kendini beyaz listeye alamasın. Ölçüldü: `-c safe.directory` ile klon
     * yine düşüyor.
     *
     * Bu yüzden istisna imajda, SİSTEM düzeyinde ve TEK BİR YOL için duruyor
     * (rooms/Dockerfile). Gerekçe orada; özeti: `*` "her depoya güven" demek,
     * bu ise agent'ın yazamadığı tek bir depoya güven demek.
     */
    const script = [
      `git -c core.hooksPath=/dev/null -c protocol.file.allow=always ` +
        `clone --shared --no-checkout --no-recurse-submodules ${CENTRAL_REPO} ${dir}`,
      `git -C ${dir} checkout -b ${branch} ${baseSha}`,
    ].join(" && ");
    await sh(container, agentUser(a.name), script, `${a.name} klonu`, 300_000);
    out.push({ agent: a.name, branch });
  }
  return out;
}
