/**
 * The words every page's data is built from: verdicts, modes, money and times, as the schemas that
 * check them. JSON has no bigint and no date, so money is wei as a decimal string and a time is ISO.
 */
import { z } from "zod";
import type { Tile } from "../../../gallery.ts";

export const VERDICTS = ["passed", "failed", "not-reproducible", "running"] as const satisfies readonly Tile["verdict"][];
export const MODES = ["flash", "sprint", "project"] as const satisfies readonly Tile["mode"][];
export const WEI = z.string().regex(/^[0-9]+$/, "an amount in wei");
export const WHEN = z.iso.datetime({ offset: true });
/** the chain counts in seconds, and a date in milliseconds */
export const MS_IN_A_SECOND = 1000;

export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;
