import * as z from "zod";

export const BrowserDriverSchema = z.enum(["cdp", "patchright"]);
export type BrowserDriver = z.infer<typeof BrowserDriverSchema>;
