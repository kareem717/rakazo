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
