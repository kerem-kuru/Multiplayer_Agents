import { z } from "zod";

/**
 * Kimlikler. Oda, oturum ve agent kimlikleri kısa ve okunabilir olsun —
 * defterde, log'da ve branch adında ("room-42/frontend") görünürler.
 */
export const RoomId = z.string().uuid();
export const SessionId = z.string().uuid();

/** Agent adı = rol YAML'ındaki `name`. Branch ve klasör adı olarak da kullanılır. */
export const AgentName = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/, "agent adı küçük harf, rakam ve tire olmalı");

export const UserId = z.string().min(1).max(64);
export const TaskId = z.string().min(1).max(64);
export const ApprovalId = z.string().min(1).max(64);

export type RoomId = z.infer<typeof RoomId>;
export type SessionId = z.infer<typeof SessionId>;
export type AgentName = z.infer<typeof AgentName>;
export type UserId = z.infer<typeof UserId>;
export type TaskId = z.infer<typeof TaskId>;
export type ApprovalId = z.infer<typeof ApprovalId>;

/**
 * Bir event'i kimin ürettiği. Agent context'ine "[Ali]: ..." diye giren etiket
 * buradan üretilir — agent kime cevap verdiğini bilmeli.
 */
export const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), id: UserId, name: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("agent"), name: AgentName }),
  z.object({ kind: z.literal("system") }),
]);
export type Actor = z.infer<typeof Actor>;

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case "human":
      return actor.name;
    case "agent":
      return actor.name;
    case "system":
      return "system";
  }
}
