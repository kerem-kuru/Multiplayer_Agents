import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRoomConfig, RoomConfigError, findAgent } from "../src/config/loadRoomConfig.js";
import { mountPlan } from "../src/room/layout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const minimal = `
version: 1
name: Test odası
agents:
  - name: frontend
    systemPrompt: "frontend"
    workspace: worktrees/frontend
    writable: [worktrees/frontend, contracts]
  - name: backend
    systemPrompt: "backend"
    workspace: worktrees/backend
    writable: [worktrees/backend, contracts]
`;

describe("rol konfigürasyonu", () => {
  it("örnek YAML geçerli", async () => {
    const text = await readFile(path.join(root, "config", "room.example.yaml"), "utf8");
    const { config, digest } = parseRoomConfig(text);
    expect(config.agents.length).toBeGreaterThanOrEqual(2);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  // Hafta 7: üçüncü agent artık journal'a yazamaz (journal root:root 0755).
  // Yazılabilir tek iki şey: kendi worktree'si ve contracts.
  it("agent sayısı dizi uzunluğundan gelir — üçüncüyü eklemek tek blok", () => {
    const { config } = parseRoomConfig(minimal);
    expect(config.agents.map((a) => a.name)).toEqual(["frontend", "backend"]);

    const withThird = parseRoomConfig(
      `${minimal}  - name: security\n    systemPrompt: "security"\n    workspace: worktrees/security\n    writable: [worktrees/security, contracts]\n`,
    );
    expect(withThird.config.agents).toHaveLength(3);
    expect(findAgent(withThird.config, "security")?.workspace).toBe("worktrees/security");
  });

  it("aynı isimli iki agent'ı reddeder", () => {
    const dup = minimal.replace("name: backend", "name: frontend");
    expect(() => parseRoomConfig(dup)).toThrow(RoomConfigError);
  });

  it("agent'ın kendi alanı dışına yazma iznini reddeder", () => {
    const bad = minimal.replace(
      "writable: [worktrees/backend, contracts]",
      "writable: [worktrees/frontend]",
    );
    expect(() => parseRoomConfig(bad)).toThrow(RoomConfigError);
  });

  it("bilinmeyen alanı reddeder — sessiz yazım hatası olmasın", () => {
    expect(() => parseRoomConfig(`${minimal}    tools_allow: [bash]\n`)).toThrow(RoomConfigError);
  });

  it("varsayılanlar dolar", () => {
    const { config } = parseRoomConfig(minimal);
    expect(config.agents[0]!.model).toBe("claude-sonnet-5");
    expect(config.contractsDir).toBe("contracts");
    expect(config.budget.maxUsd).toBe(25);
  });

  it("mount planı: kendi worktree'si rw, diğerleri ro", () => {
    const { config } = parseRoomConfig(minimal);
    const plans = mountPlan(config);
    const fe = plans.find((p) => p.agent === "frontend")!;
    expect(fe.readWrite).toContain("worktrees/frontend");
    expect(fe.readOnly).toContain("worktrees/backend");
    expect(fe.readOnly).not.toContain("contracts");
  });
});
