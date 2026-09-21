import { execFile } from "node:child_process";

/**
 * Korumalı git çağrısı — bu depodaki TEK `execFile("git", …)`.
 *
 * İki kural burada yaşıyor:
 *
 * 1. **Host, agent'ın yazabildiği bir depoda git çalıştırmaz.** Bu modül
 *    container içinde koşar (runner'ın içine bundle'lanır ve `docker exec`
 *    ile çağrılır). Host tarafı git'e asla doğrudan dokunmaz; sunucu yalnızca
 *    `docker exec` ile bu CLI'yı çağırır.
 *
 * 2. **Container içindeki çağrı da korumalıdır.** Agent `.git/config`'e
 *    `core.fsmonitor = touch /tmp/pwned` yazabilir veya `.git/hooks/*` ekleyebilir;
 *    bizim araçlarımız onu TETİKLEMEZ. `-c` ile verilen ayarlar depodaki
 *    config'i ezer.
 *
 * `safe.directory=*`: workspace bind mount üzerinden geliyor ve sahipliği
 * container kullanıcısıyla uyuşmayabilir — git "dubious ownership" deyip
 * durmasın.
 */
const SAFE = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "safe.directory=*",
];

export interface GitOptions {
  /** Ek ortam değişkenleri — `GIT_INDEX_FILE` geçici index için buradan gelir. */
  env?: Record<string, string>;
  /** Büyük diff'ler için. Varsayılan 32 MB. */
  maxBuffer?: number;
  timeoutMs?: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    cause: unknown,
  ) {
    super(`git ${args.join(" ")} başarısız: ${stderr.trim() || String(cause)}`);
    this.name = "GitError";
  }
}

export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) =>
    execFile(
      "git",
      [...SAFE, ...args],
      {
        cwd,
        env: {
          ...process.env,
          // Kimlik sorusu bir CI/container'da sonsuza kadar asılı kalmak demek.
          GIT_TERMINAL_PROMPT: "0",
          // Okuma amaçlı çağrılar index.lock için yarışmasın.
          GIT_OPTIONAL_LOCKS: "0",
          ...(opts.env ?? {}),
        },
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 20_000,
        encoding: "utf8",
      },
      (err, stdout, stderr) =>
        err ? reject(new GitError(args, String(stderr ?? ""), err)) : resolve(stdout),
    ),
  );
}

/** Çıktısı önemsiz, hatası önemli olan çağrılar için. */
export async function gitOk(cwd: string, args: string[], opts: GitOptions = {}): Promise<boolean> {
  try {
    await git(cwd, args, opts);
    return true;
  } catch {
    return false;
  }
}
