import { z } from "zod";

export const Priority = z.enum(["high", "normal", "low"]);

export const EventType = z.string().min(1).max(100);

export const EventCategory = z
  .enum([
    "communication",
    "calendar",
    "system",
    "business",
    "development",
    "monitoring",
    "custom",
  ])
  .optional();

export const N8nWebhookPayload = z.object({
  type: EventType,
  category: EventCategory,
  priority: Priority,
  data: z.record(z.unknown()),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  source_workflow: z.string().max(255).optional(),
  timestamp: z.string().datetime().optional(),
});

export type N8nWebhookPayloadType = z.infer<typeof N8nWebhookPayload>;

const WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET || "";

export function validateWebhookSecret(
  provided: string | string[] | undefined
): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn(
      "N8N_WEBHOOK_SECRET not configured — webhook is unprotected!"
    );
    return true;
  }
  const value = Array.isArray(provided) ? provided[0] : provided;
  return value === WEBHOOK_SECRET;
}
