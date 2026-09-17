import Docker from "dockerode";

/**
 * Oda container'ı yaşam döngüsü.
 *
 * Bir oda = bu imajdan bir container, içinde N agent süreci. Container PID 1
 * hiçbir iş yapmaz (`sleep infinity`); agent süreçleri Hafta 2'de exec ile
 * başlatılacak.
 *
 * Neden dockerode, CLI değil: Hafta 2-3'te agent çıktısı uzun ömürlü exec
 * stream'i olarak akacak, Hafta 11'de container istatistikleri okunacak.
 * İkisi de kütüphane üzerinden gerçek stream/nesne veriyor; CLI tarafında
 * süreç yönetimi ve metin ayrıştırması olurdu — ki "metin kazıma yok" kuralı
 * tam olarak bunun için var.
 *
 * Create seçenekleri (`buildCreateOptions`) saf tutuldu: docker olmadan test edilir.
 */

let client: Docker | null = null;

/** Docker istemcisi. Windows'ta named pipe, Linux/macOS'ta unix socket — varsayılan. */
export function getDocker(): Docker {
  if (!client) client = new Docker();
  return client;
}

export const ROOM_MOUNT = "/room";

/**
 * Windows yollarını bind mount'un kabul ettiği biçime çevirir:
 * `C:\Users\x\room` → `C:/Users/x/room`.
 */
export function toDockerPath(hostPath: string): string {
  return hostPath.replace(/\\/g, "/");
}

/** Oda kimliğinin kısa hali — container ve branch adlarında kullanılır. */
export function shortRoomId(roomId: string): string {
  return roomId.replace(/-/g, "").slice(0, 8);
}

export function roomContainerName(roomId: string): string {
  return `agent-rooms-room-${shortRoomId(roomId)}`;
}

/** Odaya ait container'ları bulmak için — temizlik ve kapı script'i bunu kullanır. */
export const ROOM_LABEL = "agent-rooms.room";
export const MANAGED_LABEL = "agent-rooms.managed";

export interface RoomContainerSpec {
  roomId: string;
  /** Host tarafındaki oda kökü — container içinde /room olarak görünür. */
  roomRoot: string;
  image: string;
  memoryMb?: number;
  cpus?: number;
}

export function buildCreateOptions(spec: RoomContainerSpec): Docker.ContainerCreateOptions {
  const { roomId, roomRoot, image, memoryMb = 2048, cpus = 2 } = spec;
  return {
    Image: image,
    name: roomContainerName(roomId),
    Labels: { [MANAGED_LABEL]: "true", [ROOM_LABEL]: roomId },
    WorkingDir: ROOM_MOUNT,
    HostConfig: {
      Binds: [`${toDockerPath(roomRoot)}:${ROOM_MOUNT}`],
      Memory: memoryMb * 1024 * 1024,
      NanoCpus: cpus * 1_000_000_000,
      // Döngüye giren bir agent'ın fork bombasına dönmesini engeller.
      PidsLimit: 512,
    },
  };
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await getDocker().ping();
    return true;
  } catch {
    return false;
  }
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await getDocker().getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Container'ı ayağa kaldırır, kimliğini döner. Aynı odadan artık kalmışsa temizler. */
export async function startRoomContainer(spec: RoomContainerSpec): Promise<string> {
  const docker = getDocker();
  await stopRoomContainer(roomContainerName(spec.roomId));

  const container = await docker.createContainer(buildCreateOptions(spec));
  await container.start();
  return container.id;
}

/** Container'ı durdurup siler. Yoksa sessizce geçer. */
export async function stopRoomContainer(container: string): Promise<void> {
  try {
    await getDocker().getContainer(container).remove({ force: true });
  } catch (err) {
    // 404 = zaten yok. Başka bir hataysa çağıran görsün.
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

export async function containerStatus(container: string): Promise<string | null> {
  try {
    const info = await getDocker().getContainer(container).inspect();
    return info.State.Status;
  } catch {
    return null;
  }
}

/** Bu araç tarafından yönetilen container'lar — kapı script'inin temizliği için. */
export async function listRoomContainers(roomId?: string): Promise<Docker.ContainerInfo[]> {
  const filters: Record<string, string[]> = { label: [`${MANAGED_LABEL}=true`] };
  if (roomId) filters.label!.push(`${ROOM_LABEL}=${roomId}`);
  return getDocker().listContainers({ all: true, filters: JSON.stringify(filters) });
}
