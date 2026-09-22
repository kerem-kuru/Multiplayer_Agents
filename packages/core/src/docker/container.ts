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

/**
 * Oda volume'unun adı.
 *
 * Hafta 7, Karar 2: `/room` artık host'taki bir klasöre bind mount EDİLMİYOR,
 * named volume. Gerekçe: Docker Desktop'ta (Windows/macOS) bind mount
 * üzerindeki `chown` ve izin bitleri güvenilir çalışmaz. Bu haftanın tamamı
 * "izolasyon dosya sistemiyle uygulanır" üzerine kurulu; bind mount'ta kalsaydı
 * `chmod 0750` hatasız döner, `stat` beklediğimizi gösterir ve kapı yeşil
 * yanardı — gerçek bir sınır olmadan. Yeşil yanan ve yalan söyleyen bir
 * güvenlik özelliği, hiç olmayanından kötüdür.
 *
 * Bedeli: host artık oda dosyalarını doğrudan göremez, her inceleme
 * `docker exec` ile yapılır (scripts/lib/room-exec.sh).
 *
 * Tam uuid kullanılıyor, kısa hali değil: volume container'dan uzun yaşayabilir
 * ve 8 karakterlik bir çakışma, silinen bir odanın volume'unu yaşayan bir odaya
 * bağlamak demek olurdu.
 */
export function roomVolumeName(roomId: string): string {
  return `room-${roomId}`;
}

export interface RoomContainerSpec {
  roomId: string;
  image: string;
  /** Odadaki agent sayısı — bellek sınırı bundan türer. */
  agentCount?: number;
  memoryMb?: number;
  cpus?: number;
}

/** Agent sayısına göre bellek: agent başına 2 GB, tavan 8 GB. */
export function roomMemoryMb(agentCount: number): number {
  return Math.min(Math.max(agentCount, 1) * 2048, 8192);
}

export function buildCreateOptions(spec: RoomContainerSpec): Docker.ContainerCreateOptions {
  const { roomId, image, agentCount = 1, cpus = 2 } = spec;
  const memoryMb = spec.memoryMb ?? roomMemoryMb(agentCount);
  return {
    Image: image,
    name: roomContainerName(roomId),
    Labels: { [MANAGED_LABEL]: "true", [ROOM_LABEL]: roomId },
    WorkingDir: ROOM_MOUNT,
    HostConfig: {
      Mounts: [
        {
          Type: "volume",
          Source: roomVolumeName(roomId),
          Target: ROOM_MOUNT,
        },
      ],
      Memory: memoryMb * 1024 * 1024,
      NanoCpus: cpus * 1_000_000_000,
      // Döngüye giren bir agent'ın fork bombasına dönmesini engeller.
      PidsLimit: 512,
    },
  };
}

/** Volume'u yaratır (varsa dokunmaz). Etiket sweeper'ın sahipsizleri bulması için. */
export async function ensureRoomVolume(roomId: string): Promise<string> {
  const name = roomVolumeName(roomId);
  await getDocker().createVolume({
    Name: name,
    Labels: { [MANAGED_LABEL]: "true", [ROOM_LABEL]: roomId },
  });
  return name;
}

/** Volume'u siler. Yoksa sessizce geçer. */
export async function removeRoomVolume(roomId: string): Promise<void> {
  try {
    await getDocker().getVolume(roomVolumeName(roomId)).remove({ force: true });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
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
  // Volume container'dan ONCE var olmali; yoksa Docker onu sahipsiz yaratir
  // ve sweeper'in aradigi etiketi tasimaz.
  await ensureRoomVolume(spec.roomId);

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

/**
 * Odaya ait etiketi taşıyan volume'lar. Sweeper sahipsizleri bununla buluyor.
 *
 * Volume container'dan UZUN yaşar: container silinse bile volume kalır ve
 * kimse temizlemezse diskte birikir.
 */
export async function listRoomVolumes(): Promise<Array<{ name: string; roomId: string }>> {
  const res = await getDocker().listVolumes({
    filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }),
  });
  const out: Array<{ name: string; roomId: string }> = [];
  for (const v of res.Volumes ?? []) {
    const roomId = (v.Labels ?? {})[ROOM_LABEL];
    if (roomId) out.push({ name: v.Name, roomId });
  }
  return out;
}
