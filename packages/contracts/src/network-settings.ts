import * as z from "zod";
import type { EgressConfig } from "./network-egress.js";
import { parseEgressConfig } from "./network-egress.js";

export const NetworkEgressConfigSchema = z
  .custom<EgressConfig>((value) => {
    try {
      parseEgressConfig(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid network configuration")
  .transform(parseEgressConfig);

export const NetworkSettingsSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    writable: z.boolean(),
    active: NetworkEgressConfigSchema,
    saved: NetworkEgressConfigSchema,
    revision: z.string(),
    restartRequired: z.boolean(),
  }),
]);
export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>;

export const NetworkApplyStatusSchema = z.object({
  available: z.boolean(),
  operationId: z.string().nullable(),
  revision: z.string().nullable(),
  phase: z.enum(["idle", "checking", "restarting", "verifying", "succeeded", "failed"]),
  error: z.string().nullable(),
});
export type NetworkApplyStatus = z.infer<typeof NetworkApplyStatusSchema>;
export const NetworkApplyInputSchema = z
  .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
