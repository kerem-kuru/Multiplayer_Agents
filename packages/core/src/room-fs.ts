import type { RoomConfig } from "@agent-rooms/protocol";

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
