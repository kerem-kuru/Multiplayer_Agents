import type { RoomConfig } from "@agent-rooms/protocol";
import { execCapture } from "./agents/exec.js";

/**
 * Hafta 7, Adım 2 — izin planı.
 *
 * Bu dosyanın ÜST yarısı saftır: config + mevcut uid ataması girer, uygulanacak
 * her şeyi içeren bir plan çıkar. Dosya sistemine dokunan uygulayıcı (Adım 3)
 * yalnızca bu planı yürütür.
 *
 * Neden ayrı: izolasyonun doğruluğu "hangi klasör kime ait, modu ne" sorusunun
 * cevabında. O cevabı container açmadan, saniyeler içinde test edebilmek
 * gerekiyor; `docker exec` ile stat okuyarak test etmek hem yavaş hem de
 * hatayı planla uygulama arasında hangisinde olduğunu söylemez.
 *
 * İzolasyonun mount ile DEĞİL Unix kullanıcılarıyla uygulanmasının gerekçesi
 * README "Karar notları"nda: bir container'daki mount'lar o container'daki tüm
 * süreçler için aynıdır; süreç başına farklı mount görünümü CAP_SYS_ADMIN
 * ister ve sandbox'ı deler.
 */

/** Merkez deponun sahibi. Hiçbir agent grubunun üyesi değildir. */
export const INTEGRATOR = "rooms-integrator";
export const INTEGRATOR_ID = 9000;

/** Tek ortak yazılabilir alanın grubu. */
export const CONTRACTS_GROUP = "rooms-contracts";
export const CONTRACTS_GID = 19999;

/** İlk agent 10001. */
export const AGENT_UID_BASE = 10000;
/** Worktree okuyucu grupları: 20000 + agent sırası. */
export const WTR_GID_BASE = 20000;

export type FsUser = {
  name: string;
  uid: number;
  gid: number;
  /** Ek gruplar (birincil grup hariç). */
  groups: string[];
  home: string;
};

export type FsGroup = { name: string; gid: number };

export type FsDir = {
  path: string;
  owner: string;
  group: string;
  /** Sekiz tabanında, setgid için dört hane: "0750", "2775". */
  mode: string;
};

export type FsPlan = {
  users: FsUser[];
  groups: FsGroup[];
  dirs: FsDir[];
};

export const agentUser = (name: string) => `agent-${name}`;
export const wtrGroup = (name: string) => `wtr-${name}`;

/**
 * Bir agent'ın uid'i oda yaratılırken bir kez atanır ve `agent_runtime.uid`
 * sütununda yaşar. YAML sonradan yeniden sıralansa bile DEĞİŞMEZ: uid
 * değişmesi, o uid'e ait dosyaların bir anda başka bir agent'ın olması demek.
 *
 * `existing` DB'den gelen atamalar. Listede olmayan agent sıradaki boş uid'i
 * alır.
 */
export function assignUids(
  agentNames: readonly string[],
  existing: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();

  for (const name of agentNames) {
    const uid = existing[name];
    if (typeof uid === "number") {
      out[name] = uid;
      used.add(uid);
    }
  }
  // Artık bu odada olmayan agent'ların uid'leri de rezerve kalır: klasörleri
  // hâlâ o uid'e ait olabilir ve yeni bir agent'a verilirse dosyaları devralır.
  for (const uid of Object.values(existing)) used.add(uid);

  let next = AGENT_UID_BASE + 1;
  for (const name of agentNames) {
    if (out[name] !== undefined) continue;
    while (used.has(next)) next += 1;
    out[name] = next;
    used.add(next);
  }
  return out;
}

/**
 * Config'ten uygulanacak kullanıcı/grup/dizin planını üretir.
 *
 * `uids` `assignUids` çıktısıdır. Eksik bir agent varsa hata: uid ataması
 * sessizce burada yapılırsa DB'ye yazılmaz ve bir sonraki açılışta kayar.
 */
export function planRoomFs(config: RoomConfig, uids: Readonly<Record<string, number>>): FsPlan {
  const agents = config.agents;
  const names = agents.map((a) => a.name);

  for (const name of names) {
    if (typeof uids[name] !== "number") {
      throw new Error(`uid atanmamış agent: ${name} (assignUids çıktısı eksik)`);
    }
  }

  const uidOf = (name: string): number => uids[name] as number;
  // wtr gid'i uid'den TÜRETİLİR (20000 + sıra). Config'teki dizin sırasından
  // türetilseydi YAML yeniden sıralandığında grup numaraları kayardı ve
  // uid'lerin sabitliği tek başına yetmezdi.
  const wtrGidOf = (name: string): number => WTR_GID_BASE + (uidOf(name) - AGENT_UID_BASE);

  const groups: FsGroup[] = [
    { name: INTEGRATOR, gid: INTEGRATOR_ID },
    { name: CONTRACTS_GROUP, gid: CONTRACTS_GID },
  ];
  for (const a of agents) {
    groups.push({ name: agentUser(a.name), gid: uidOf(a.name) });
    groups.push({ name: wtrGroup(a.name), gid: wtrGidOf(a.name) });
  }

  const users: FsUser[] = [
    {
      name: INTEGRATOR,
      uid: INTEGRATOR_ID,
      gid: INTEGRATOR_ID,
      groups: [],
      home: `/home/${INTEGRATOR}`,
    },
  ];

  for (const a of agents) {
    const extra: string[] = [];

    // contracts grubu: yalnızca writable'da contracts varsa.
    const writesContracts = a.writable.some(
      (w) => w === config.contractsDir || w.startsWith(`${config.contractsDir}/`),
    );
    if (writesContracts) extra.push(CONTRACTS_GROUP);

    // readable → başka worktree'lerin okuyucu grupları.
    const readsAll = a.readable.includes("worktrees/*");
    for (const other of names) {
      if (other === a.name) continue;
      const named = a.readable.includes(`worktrees/${other}`);
      if (readsAll || named) extra.push(wtrGroup(other));
    }

    users.push({
      name: agentUser(a.name),
      uid: uidOf(a.name),
      gid: uidOf(a.name),
      groups: extra,
      home: `/home/agents/${a.name}`,
    });
  }

  // Sıra ÖNEMLİ: uygulayıcı listeyi baştan sona yürüyor, üst klasör altından
  // önce gelmeli.
  const dirs: FsDir[] = [
    { path: "/room", owner: "root", group: "root", mode: "0755" },
    // Merkez depo: agent'lar okur (klonlama ve alternates için gerekli), yazamaz.
    { path: "/room/repo.git", owner: INTEGRATOR, group: INTEGRATOR, mode: "0755" },
    { path: "/room/worktrees", owner: "root", group: "root", mode: "0755" },
  ];

  for (const a of agents) {
    // 0750: grup dışındakiler dizine GİREMEZ. Okuma yetkisi verilen agent'lar
    // wtr-<ad> grubuna eklenerek içeri alınır.
    dirs.push({
      path: `/room/worktrees/${a.name}`,
      owner: agentUser(a.name),
      group: wtrGroup(a.name),
      mode: "0750",
    });
  }

  dirs.push(
    // setgid (2775): içinde yaratılan dosyalar rooms-contracts grubunu miras
    // alır, yoksa ikinci agent birincinin dosyasını değiştiremez.
    { path: `/room/${config.contractsDir}`, owner: "root", group: CONTRACTS_GROUP, mode: "2775" },
    // Defter Hafta 8'in işi; bu hafta hiçbir agent yazamaz.
    { path: `/room/${config.journalDir}`, owner: "root", group: "root", mode: "0755" },
    { path: "/home/agents", owner: "root", group: "root", mode: "0755" },
  );

  for (const a of agents) {
    // SDK oturum dosyaları burada durur; başka agent göremesin.
    dirs.push({
      path: `/home/agents/${a.name}`,
      owner: agentUser(a.name),
      group: agentUser(a.name),
      mode: "0700",
    });
  }

  dirs.push({ path: `/home/${INTEGRATOR}`, owner: INTEGRATOR, group: INTEGRATOR, mode: "0700" });

  return { users, groups, dirs };
}

/* ------------------------------------------------------------------ *
 * Uygulayıcı — planı container içinde ROOT olarak yürütür.
 * ------------------------------------------------------------------ */

/**
 * Planı tek bir kabuk script'ine çevirir.
 *
 * Saf tutuldu: script METNİ Docker olmadan test edilebiliyor. Tek tek
 * `docker exec` yerine tek script olmasının sebebi hız — 3 agentlı bir odada
 * plan ~25 komut, her biri ayrı exec olsaydı oda açılışı saniyeler uzardı.
 *
 * İdempotent olmak ZORUNDA: container yeniden başladığında ve sweeper
 * mutabakatında aynı plan tekrar uygulanıyor.
 */
export function fsPlanScript(plan: FsPlan): string {
  const lines: string[] = ["set -eu"];

  for (const g of plan.groups) {
    // -f: grup zaten varsa hata verme.
    lines.push(`groupadd -f -g ${g.gid} ${g.name}`);
  }

  for (const u of plan.users) {
    lines.push(
      `id -u ${u.name} >/dev/null 2>&1 || ` +
        `useradd -u ${u.uid} -g ${u.gid} -d ${u.home} -M -s /bin/bash ${u.name}`,
    );
    // Ek grupları her seferinde YENİDEN yaz: YAML'dan bir `readable` satırı
    // silindiğinde kullanıcının o gruptan da çıkması gerekiyor. `-a` ile
    // eklemek, kaldırılan yetkinin sessizce kalması demekti.
    lines.push(`usermod -G "${u.groups.join(",")}" ${u.name}`);
  }

  for (const d of plan.dirs) {
    lines.push(`mkdir -p ${d.path}`);
    // Sıra önemli: chown setgid bitini DÜŞÜRÜR, bu yüzden chmod sonra gelir.
    lines.push(`chown ${d.owner}:${d.group} ${d.path}`);
    lines.push(`chmod ${d.mode} ${d.path}`);
  }

  return lines.join("\n");
}

/** `stat -c` çıktısını planla karşılaştırmak için tek satırlık biçim. */
export const STAT_FORMAT = "%n %U %G %a";

/** "0750" → "750"; stat sekizli modu baştaki sıfır olmadan yazar. */
export function normalizeMode(mode: string): string {
  const trimmed = mode.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

export type FsDrift = { path: string; expected: string; actual: string };

/**
 * `stat` çıktısını planla karşılaştırır. Saf: metin girer, sapma listesi çıkar.
 *
 * Adım 9'daki izin denetimi ve Adım 3'ün kabul kriteri aynı fonksiyonu
 * kullanıyor — "beklenen izin" tanımının iki kopyası olmasın.
 */
export function diffFsStat(plan: FsPlan, statOutput: string): FsDrift[] {
  const seen = new Map<string, string>();
  for (const raw of statOutput.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [path, owner, group, mode] = parts as [string, string, string, string];
    seen.set(path, `${owner}:${group} ${normalizeMode(mode)}`);
  }

  const drift: FsDrift[] = [];
  for (const d of plan.dirs) {
    const expected = `${d.owner}:${d.group} ${normalizeMode(d.mode)}`;
    const actual = seen.get(d.path);
    if (actual === undefined) {
      drift.push({ path: d.path, expected, actual: "yok" });
    } else if (actual !== expected) {
      drift.push({ path: d.path, expected, actual });
    }
  }
  return drift;
}

/**
 * Planı container içinde ROOT olarak uygular.
 *
 * Root gerekiyor: `useradd`/`chown` başka türlü yapılamaz. Bu, "agent'ın
 * deposunda root git çalıştırma" kuralıyla çelişmiyor — burada git yok, kimlik
 * ve izin kurulumu var ve agent süreçleri henüz başlamadı.
 */
export async function applyFsPlan(container: string, plan: FsPlan): Promise<void> {
  const res = await execCapture({
    container,
    user: "root",
    cmd: ["sh", "-c", fsPlanScript(plan)],
    timeoutMs: 120_000,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `izin planı uygulanamadı (çıkış ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
}

/**
 * Planla gerçeği karşılaştırır. Boş dizi = kayma yok.
 *
 * Adım 3'ün kabul kriteri ve Adım 9'un periyodik denetimi aynı yerden okuyor.
 */
export async function verifyFsPlan(container: string, plan: FsPlan): Promise<FsDrift[]> {
  const paths = plan.dirs.map((d) => d.path).join(" ");
  const res = await execCapture({
    container,
    user: "root",
    cmd: ["sh", "-c", `stat -c '${STAT_FORMAT}' ${paths} 2>/dev/null || true`],
    timeoutMs: 30_000,
  });
  return diffFsStat(plan, res.stdout);
}
