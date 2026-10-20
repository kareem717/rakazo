import { z } from "zod";
import { Id } from "./ids.js";

/** Call transport is independent of the connections used to read replies and transcribe clips. */
export const LiveCallSettingsSchema = z.object({
  provider: z.string().trim().min(1).max(80).nullable().default(null),
  modelId: z.string().trim().max(200).default(""),
  speechModel: z.string().trim().max(200).default(""),
  transcriptionModel: z.string().trim().max(200).default(""),
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}$/)
    .default("en"),
  maxDurationSeconds: z.number().int().min(60).max(3600).default(1800),
});
export type LiveCallSettings = z.infer<typeof LiveCallSettingsSchema>;

export const LiveCallProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  defaults: LiveCallSettingsSchema,
});

/** Only a short-lived, single-call transport credential may cross this boundary. */
export const LiveCallConnectionSchema = z.object({
  id: Id,
  provider: z.string(),
  connection: z.record(z.string(), z.unknown()),
});
export type LiveCallConnection = z.infer<typeof LiveCallConnectionSchema>;

export const LiveCallResultSchema = z.object({
  status: z.enum(["working", "complete", "waiting_input", "failed"]),
  requestId: Id,
  text: z.string(),
});
export type LiveCallResult = z.infer<typeof LiveCallResultSchema>;
