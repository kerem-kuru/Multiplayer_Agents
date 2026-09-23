import { describe, expect, it } from "vitest";
import {
  CONTRACTS_READER,
  contractReadCommand,
  isPlausibleContractPath,
} from "../src/contracts-read.js";

/**
 * Hafta 7, Adım 7 — sözleşme içeriği okuma.
 *
 * Asıl kanıt canlı container'da (`gate:w7`, symlink satırları): ilk sürüm
 * `contracts/leak -> /room/worktrees/backend/...` ve `-> /etc/shadow`
 * linklerini root ile okuyup döndürüyordu. Burada ölçülen şey komutun
 * şekli: root değil, yol kabuğa gömülmüyor, realpath sınırı var.
 */

describe("sözleşme okuma", () => {
  it("root ile okumuyor ve ek grup yüklemiyor", () => {
    expect(CONTRACTS_READER).toBe("nobody:rooms-contracts");
    expect(CONTRACTS_READER.startsWith("root")).toBe(false);
  });

  it("yol argüman olarak geçiyor, betiğe gömülmüyor", () => {
    const evil = `x"; cat /etc/shadow; echo "`;
    const cmd = contractReadCommand(evil);
    expect(cmd[cmd.length - 1]).toBe(evil);
    expect(cmd[2]).not.toContain("shadow");
  });

  it("çözülmüş yolu contracts/ ile sınırlıyor", () => {
    const script = contractReadCommand("api.md")[2];
    expect(script).toContain("realpath -e");
    expect(script).toContain("/room/contracts/*) ;;");
  });

  it("kaba yol kontrolü", () => {
    expect(isPlausibleContractPath("api.md")).toBe(true);
    expect(isPlausibleContractPath("v1/api.md")).toBe(true);
    expect(isPlausibleContractPath("")).toBe(false);
    expect(isPlausibleContractPath("/etc/passwd")).toBe(false);
    expect(isPlausibleContractPath("../worktrees/backend/x")).toBe(false);
    expect(isPlausibleContractPath("a/../../x")).toBe(false);
  });
});
