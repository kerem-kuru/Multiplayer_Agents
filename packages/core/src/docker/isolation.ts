import type { RoomConfig } from "@agent-rooms/protocol";
import { roomLayout } from "@agent-rooms/protocol";
import { ROOM_MOUNT, execInRoom, execShell } from "./container.js";

/**
 * Agent izolasyonu — container İÇİNDE, POSIX sahipliğiyle.
 *
 * Neden mount ile değil: bir oda = bir container = tek dosya sistemi. Agent
 * başına rw/ro mount vermek oda başına N container demekti. Bunun yerine her
 * agent kendi OS kullanıcısı altında koşar, klasör sahipliği kısıtı uygular.
 *
 * Kural tablosu `mountPlan()` ile aynı sonucu verir, sadece uygulama katmanı
 * farklı:
 *
 *   tek yazıcı  → owner=agent, group=room, 2750  (sahibi rw, diğer agent'lar ro)
 *   çok yazıcı  → owner=root,  group=room, 2770  (contracts: ortak yazılabilir)
 *   yazıcı yok  → owner=root,  group=room, 2750  (journal: defteri API yazar)
 *
 * setgid biti (2xxx) şart: içeride yaratılan yeni dosyalar `room` grubunu
 * miras alsın ki diğer agent'lar okuyabilsin.
 */

export const ROOM_GROUP = "room";
const MAX_USERNAME = 32;

export function agentUser(agentName: string): string {
  const user = `agent-${agentName}`;
  if (user.length > MAX_USERNAME) {
    throw new Error(
      `agent adı çok uzun: "${agentName}" → kullanıcı adı ${user.length} karakter, sınır ${MAX_USERNAME}`,
    );
  }
  return user;
}

/**
 * Ara dizinler: oda kökü ve `worktrees` gibi, layout klasörlerini TAŞIYAN ama
 * kendisi kimseye ait olmayan dizinler.
 *
 * 2755 şart. Bunlar 0777 kalırsa izolasyon delinir: bir dizin girdisini silme
 * ve yeniden adlandırma yetkisi o girdinin kendi izinlerinden değil, ÜST
 * dizininin yazma yetkisinden gelir. `worktrees` herkese yazılabilir olsaydı
 * frontend, backend'in klasörünün içine yazamadan onu `mv` ile taşıyabilirdi.
 */
export const ANCESTOR_MODE = "2755";

export function ancestorDirs(config: RoomConfig): string[] {
  const leaves = new Set(roomLayout(config));
  const dirs = new Set<string>([""]); // "" = oda kökü, /room
  for (const dir of leaves) {
    const parts = dir.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const leaf of leaves) dirs.delete(leaf);
  return [...dirs].sort();
}

export interface DirOwnership {
  /** Oda köküne göre yol: worktrees/frontend */
  dir: string;
  owner: string;
  group: string;
  /** chmod için sekizlik dizi: "2750" */
  mode: string;
  writers: string[];
}

function writesTo(writable: string[], dir: string): boolean {
  return writable.some((w) => dir === w || dir.startsWith(`${w}/`));
}

/**
 * Konfigürasyondan sahiplik planı üretir. Saf fonksiyon — docker gerekmez,
 * test edilebilir. `mountPlan()` ile aynı gerçeğin iki gösterimi.
 */
export function ownershipPlan(config: RoomConfig): DirOwnership[] {
  return roomLayout(config).map((dir) => {
    const writers = config.agents
      .filter((a) => writesTo(a.writable.length > 0 ? a.writable : [a.workspace], dir))
      .map((a) => a.name);

    if (writers.length === 1) {
      return { dir, owner: agentUser(writers[0]!), group: ROOM_GROUP, mode: "2750", writers };
    }
    if (writers.length > 1) {
      return { dir, owner: "root", group: ROOM_GROUP, mode: "2770", writers };
    }
    return { dir, owner: "root", group: ROOM_GROUP, mode: "2750", writers };
  });
}

/**
 * Container içinde root olarak koşturulacak komutlar. Saf — sırayla
 * `execInRoom(..., { user: "root" })` ile geçirilir.
 */
export function provisionCommands(config: RoomConfig): string[][] {
  const cmds: string[][] = [["groupadd", "-f", ROOM_GROUP]];

  for (const agent of config.agents) {
    const user = agentUser(agent.name);
    // -m ev dizini açar (araçların cache'i için), -g room birincil grup.
    cmds.push(["useradd", "-m", "-s", "/bin/bash", "-g", ROOM_GROUP, user]);
  }

  // Ara dizinler ÖNCE ve -R olmadan: `chown -R` oda kökünde çalışsaydı
  // altındaki agent sahipliklerini silerdi.
  for (const dir of ancestorDirs(config)) {
    const target = dir === "" ? ROOM_MOUNT : `${ROOM_MOUNT}/${dir}`;
    cmds.push(["chown", `root:${ROOM_GROUP}`, target]);
    cmds.push(["chmod", ANCESTOR_MODE, target]);
  }

  for (const { dir, owner, group, mode } of ownershipPlan(config)) {
    const target = `${ROOM_MOUNT}/${dir}`;
    cmds.push(["chown", "-R", `${owner}:${group}`, target]);
    cmds.push(["chmod", mode, target]);
  }

  return cmds;
}

export interface ProvisionStep {
  argv: string[];
  code: number;
  stderr: string;
}

/** Kullanıcıları açar ve klasör sahipliğini uygular. Hatalar bastırılmaz, raporlanır. */
export async function provisionAgentUsers(
  container: string,
  config: RoomConfig,
): Promise<ProvisionStep[]> {
  const steps: ProvisionStep[] = [];
  for (const argv of provisionCommands(config)) {
    const res = await execInRoom(container, argv, { user: "root" });
    steps.push({ argv, code: res.code, stderr: res.stderr });
  }
  return steps;
}

export interface IsolationCheck {
  agent: string;
  user: string;
  /** Kendi workspace'ine yazabiliyor mu? true olmalı. */
  ownWritable: boolean;
  /** Diğer agent'ların workspace'lerine yazamıyor mu? true olmalı. */
  othersBlocked: boolean;
  /** contracts/ ortak yazılabilir alan — writable listesindeyse true olmalı. */
  contractsWritable: boolean | null;
  /** Ara dizinlere yeni girdi açamıyor mu? true olmalı — bkz. ANCESTOR_MODE. */
  parentsLocked: boolean;
  detail: string[];
}

async function canWrite(container: string, user: string, dir: string): Promise<boolean> {
  const probe = `${ROOM_MOUNT}/${dir}/.probe-${user}`;
  const res = await execShell(container, `touch '${probe}' && rm -f '${probe}'`, { user });
  return res.code === 0;
}

/**
 * Dizine yeni GİRDİ açabiliyor mu? Kardeş klasörü silme/yeniden adlandırma
 * yetkisi bu bitle aynı yerden gelir, o yüzden ayrıca denenir.
 */
async function canCreateIn(container: string, user: string, dir: string): Promise<boolean> {
  const probe = dir === "" ? `${ROOM_MOUNT}/.probe-${user}` : `${ROOM_MOUNT}/${dir}/.probe-${user}`;
  const res = await execShell(container, `mkdir '${probe}' && rmdir '${probe}'`, { user });
  return res.code === 0;
}

/**
 * Cuma dogfood kapısı: izolasyon gerçekten tutuyor mu?
 *
 * Prompt'a yazılan bir kısıt test edilemez; dosya izni edilir. Bu fonksiyon
 * her agent kullanıcısı adına yazma denemesi yapar ve sonucu raporlar.
 */
export async function verifyIsolation(
  container: string,
  config: RoomConfig,
): Promise<IsolationCheck[]> {
  const out: IsolationCheck[] = [];

  for (const agent of config.agents) {
    const user = agentUser(agent.name);
    const detail: string[] = [];

    const ownWritable = await canWrite(container, user, agent.workspace);
    detail.push(`${agent.workspace} yazma=${ownWritable ? "✓" : "✗"}`);

    let othersBlocked = true;
    for (const other of config.agents) {
      if (other.name === agent.name) continue;
      const wrote = await canWrite(container, user, other.workspace);
      if (wrote) othersBlocked = false;
      detail.push(`${other.workspace} yazma=${wrote ? "✗ SIZINTI" : "✓ engellendi"}`);
    }

    let contractsWritable: boolean | null = null;
    if (writesTo(agent.writable, config.contractsDir)) {
      contractsWritable = await canWrite(container, user, config.contractsDir);
      detail.push(`${config.contractsDir} yazma=${contractsWritable ? "✓" : "✗"}`);
    }

    // Kardeşini taşıyabiliyor mu? İçine yazamamak yetmez.
    let parentsLocked = true;
    for (const dir of ancestorDirs(config)) {
      const created = await canCreateIn(container, user, dir);
      if (created) parentsLocked = false;
      detail.push(`${dir === "" ? "/" : `${dir}/`} girdi=${created ? "✗ SIZINTI" : "✓ engellendi"}`);
    }

    out.push({
      agent: agent.name,
      user,
      ownWritable,
      othersBlocked,
      contractsWritable,
      parentsLocked,
      detail,
    });
  }

  return out;
}

export function isolationHolds(checks: IsolationCheck[]): boolean {
  return checks.every(
    (c) => c.ownWritable && c.othersBlocked && c.parentsLocked && (c.contractsWritable ?? true),
  );
}
