import { spawn } from "node:child_process";

/**
 * Oda container'ı yaşam döngüsü.
 *
 * Bir oda = bu imajdan bir container, içinde N agent süreci. Container PID 1
 * hiçbir iş yapmaz (`sleep infinity`); agent süreçleri Hafta 2'de `docker exec`
 * ile, her biri kendi kullanıcısı altında başlatılacak.
 *
 * Argüman üretimi (`buildRunArgs`) saf tutuldu: docker kurulu olmadan test edilir.
 */

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** docker CLI'ı çağırır. Kabuk kullanılmaz — argümanlar kaçışsız geçer. */
export function docker(args: string[], { timeoutMs = 120_000 } = {}): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export class DockerError extends Error {
  constructor(
    message: string,
    readonly result: DockerResult,
  ) {
    super(`${message}: ${result.stderr || result.stdout || `çıkış kodu ${result.code}`}`);
    this.name = "DockerError";
  }
}

async function dockerOrThrow(args: string[], what: string, opts?: { timeoutMs?: number }) {
  const res = await docker(args, opts);
  if (res.code !== 0) throw new DockerError(what, res);
  return res;
}

/**
 * Windows yollarını docker'ın kabul ettiği biçime çevirir:
 * `C:\Users\x\room` → `C:/Users/x/room`. Ters bölü docker CLI'da mount
 * ayrıştırmasını bozuyor; ileri bölü her iki platformda da çalışıyor.
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

export interface RoomContainerSpec {
  roomId: string;
  /** Host tarafındaki oda kökü — container içinde /room olarak görünür. */
  roomRoot: string;
  image: string;
  /** Bütçe hard stop'u Faz 2'de token tarafında; bunlar container tarafı. */
  memoryMb?: number;
  cpus?: number;
  /** Hafta 2'de agent'lar dışarı çıkacak; şimdilik varsayılan köprü. */
  network?: string;
}

export const ROOM_MOUNT = "/room";

/**
 * `docker run` argümanları. Tek mount var: oda kökü rw olarak /room'a bağlanır.
 *
 * Agent başına rw/ro ayrımı mount ile YAPILAMAZ — tek container, tek dosya
 * sistemi. O ayrım container içinde POSIX sahipliğiyle uygulanır; bkz.
 * `docker/isolation.ts`. Mount seviyesinde ayırmak oda başına N container
 * demekti, bu da "bir oda = bir container" kararını bozardı.
 */
export function buildRunArgs(spec: RoomContainerSpec): string[] {
  const { roomId, roomRoot, image, memoryMb = 2048, cpus = 2, network } = spec;
  const args = [
    "run",
    "-d",
    "--name",
    roomContainerName(roomId),
    "--label",
    "agent-rooms.managed=true",
    "--label",
    `agent-rooms.room=${roomId}`,
    "-v",
    `${toDockerPath(roomRoot)}:${ROOM_MOUNT}`,
    "-w",
    ROOM_MOUNT,
    "--memory",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
    // Döngüye giren bir agent'ın fork bombasına dönmesini engeller.
    "--pids-limit",
    "512",
  ];
  if (network) args.push("--network", network);
  args.push(image);
  return args;
}

export async function dockerAvailable(): Promise<boolean> {
  return (await docker(["info"], { timeoutMs: 15_000 })).code === 0;
}

export async function imageExists(image: string): Promise<boolean> {
  const res = await docker(["image", "inspect", image], { timeoutMs: 20_000 });
  return res.code === 0;
}

/** Container'ı ayağa kaldırır, tam kimliğini döner. */
export async function startRoomContainer(spec: RoomContainerSpec): Promise<string> {
  const name = roomContainerName(spec.roomId);
  // Aynı odadan artık kalmışsa temizle — yeniden açılabilir olsun.
  await docker(["rm", "-f", name], { timeoutMs: 30_000 });
  const res = await dockerOrThrow(buildRunArgs(spec), `container başlatılamadı (${name})`);
  return res.stdout.split("\n").pop()!.trim();
}

export async function stopRoomContainer(container: string): Promise<void> {
  await docker(["rm", "-f", container], { timeoutMs: 60_000 });
}

export interface ExecOptions {
  /** Container içi kullanıcı. Verilmezse imajın varsayılanı (root). */
  user?: string;
  workdir?: string;
  timeoutMs?: number;
}

/** Container içinde komut koşturur. Kabuk yok — argv olduğu gibi geçer. */
export async function execInRoom(
  container: string,
  argv: string[],
  { user, workdir, timeoutMs = 60_000 }: ExecOptions = {},
): Promise<DockerResult> {
  const args = ["exec"];
  if (user) args.push("-u", user);
  if (workdir) args.push("-w", workdir);
  args.push(container, ...argv);
  return docker(args, { timeoutMs });
}

/** Container içinde `sh -lc` ile kabuk satırı koşturur (izin testleri için). */
export function execShell(
  container: string,
  script: string,
  opts: ExecOptions = {},
): Promise<DockerResult> {
  return execInRoom(container, ["sh", "-c", script], opts);
}

export async function containerStatus(container: string): Promise<string | null> {
  const res = await docker(["inspect", "-f", "{{.State.Status}}", container], {
    timeoutMs: 20_000,
  });
  return res.code === 0 ? res.stdout.trim() : null;
}
