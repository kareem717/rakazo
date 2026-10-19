import * as z from "zod";

// Device authorization links only; never accept an arbitrary redirect from a gateway.
export const TailscaleAuthUrlSchema = z
  .string()
  .regex(/^https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+$/);
export const NetworkConnectionSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    provider: z.literal("tailscale"),
    state: z.enum(["connected", "needs-login", "needs-approval", "stopped", "starting"]),
    tailnet: z.string().max(253).nullable(),
    authUrl: TailscaleAuthUrlSchema.nullable(),
    exitNodes: z
      .array(
        z.object({
          name: z.string().max(253),
          value: z.string().max(253),
          online: z.boolean(),
        }),
      )
      .max(512),
  }),
]);
export type NetworkConnection = z.infer<typeof NetworkConnectionSchema>;
