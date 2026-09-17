import readline from "node:readline";
import { PassThrough } from "node:stream";
import type { RunnerCommand } from "@agent-rooms/protocol";
import { getDocker } from "../docker/container.js";

/**
 * Container içinde runner sürecini başlatır ve stdio'sunu host'a bağlar.
 *
 * `Tty: false` olduğu için docker akışı ÇOKLANMIŞ gelir (her çerçevenin
 * başında 8 baytlık başlık: hangi akış, kaç bayt). `demuxStream` bunu ayırır.
 * Tty açılsaydı stdout ve stderr aynı akışta karışır, protokol satırlarının
 * arasına log düşerdi.
 */

export interface RunnerExecOptions {
  /** Container kimliği veya adı. */
  container: string;
  /** Container içi çalışma dizini — agent'ın worktree'si. */
  workdir: string;
  env: Record<string, string>;
  user?: string;
}

export interface RunnerExec {
  /** Runner'a NDJSON komut yollar. */
  send(cmd: RunnerCommand): void;
  /** Protokol satırı geldi (stdout). */
  onLine(cb: (line: string) => void): void;
  /** Serbest metin (stderr) — sadece sunucu loguna. */
  onStderr(cb: (text: string) => void): void;
  /** Süreç kapandı. */
  onExit(cb: (code: number | null) => void): void;
  /** Kibar kapanma işe yaramazsa. */
  hardKill(pid: number): Promise<void>;
}

export async function startRunnerExec(opts: RunnerExecOptions): Promise<RunnerExec> {
  const docker = getDocker();
  const container = docker.getContainer(opts.container);

  const exec = await container.exec({
    Cmd: ["node", "/opt/runner/dist/runner.js"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: opts.user ?? "agent",
    WorkingDir: opts.workdir,
    Env: Object.entries(opts.env).map(([k, v]) => `${k}=${v}`),
  });

  const stream = await exec.start({ hijack: true, stdin: true });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  const lineCbs: Array<(line: string) => void> = [];
  const stderrCbs: Array<(text: string) => void> = [];
  const exitCbs: Array<(code: number | null) => void> = [];
  let exited = false;

  // Akış, bu fonksiyon dönmeden AKMAYA BAŞLAR; çağıran `onLine`'ı ancak
  // sonra kaydedebilir. Arada gelen satırlar kaybolmasın diye tamponlanır ve
  // ilk dinleyici kaydolunca sırayla teslim edilir. (Kaybolan bir `ready`
  // satırı agent'ı 30 sn boyunca "starting"de bırakır.)
  const pendingLines: string[] = [];
  const pendingStderr: string[] = [];
  let pendingExit: { code: number | null } | null = null;

  const rl = readline.createInterface({ input: stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (lineCbs.length === 0) {
      pendingLines.push(trimmed);
      return;
    }
    for (const cb of lineCbs) cb(trimmed);
  });

  stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (stderrCbs.length === 0) {
      pendingStderr.push(text);
      return;
    }
    for (const cb of stderrCbs) cb(text);
  });

  const finish = async (): Promise<void> => {
    if (exited) return;
    exited = true;
    let code: number | null = null;
    try {
      const info = await exec.inspect();
      code = info.ExitCode ?? null;
    } catch {
      // Container gitmiş olabilir; çıkış kodu bilinmiyor.
    }
    rl.close();
    if (exitCbs.length === 0) {
      pendingExit = { code };
      return;
    }
    for (const cb of exitCbs) cb(code);
  };

  stream.on("end", () => void finish());
  stream.on("close", () => void finish());
  stream.on("error", () => void finish());

  return {
    send(cmd) {
      if (exited) return;
      stream.write(JSON.stringify(cmd) + "\n");
    },
    onLine(cb) {
      lineCbs.push(cb);
      const buffered = pendingLines.splice(0, pendingLines.length);
      for (const line of buffered) cb(line);
    },
    onStderr(cb) {
      stderrCbs.push(cb);
      const buffered = pendingStderr.splice(0, pendingStderr.length);
      for (const text of buffered) cb(text);
    },
    onExit(cb) {
      exitCbs.push(cb);
      if (pendingExit) {
        const { code } = pendingExit;
        pendingExit = null;
        cb(code);
      }
    },
    async hardKill(pid) {
      // Ayrı bir exec: runner'ın kendi akışı tıkanmış olabilir.
      const killer = await container.exec({
        Cmd: ["kill", "-9", String(pid)],
        AttachStdout: false,
        AttachStderr: false,
        User: "root",
      });
      await killer.start({});
    },
  };
}

/** Sunucu açılış mutabakatı: container içinde sahipsiz runner kalmasın. */
export async function killStrayRunners(container: string): Promise<void> {
  const docker = getDocker();
  const exec = await docker.getContainer(container).exec({
    Cmd: ["pkill", "-f", "/opt/runner/dist/runner.js"],
    AttachStdout: false,
    AttachStderr: false,
    User: "root",
  });
  await exec.start({});
}
