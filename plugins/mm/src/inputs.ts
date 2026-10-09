/** What every `mm pod` command is told the same way: which site, which job, which seat. */
import { CommandError, InputFieldType, type InputSchema } from "@metamask/agent-wallet/plugin";
import type { Role } from "../../../src/job.ts";
import { SEATS } from "../../../src/seal.ts";
import { POD_SITE } from "./pod.ts";

export const SITE = {
  type: InputFieldType.Text, flag: "site", required: false, prompt: false,
  message: `Where POD is (default ${POD_SITE})`,
} as const satisfies InputSchema[string];

export const JOB = {
  type: InputFieldType.Text, flag: "job", required: true,
  message: "The job's name on POD, as `mm pod jobs` lists it",
} as const satisfies InputSchema[string];

export const ROLE = {
  type: InputFieldType.Select, flag: "role", required: true,
  message: "The seat: lead, builder, reviewer, qa or security",
  options: SEATS.map((seat) => ({ value: seat, label: seat })),
} as const satisfies InputSchema[string];

/** The site a command was told, or POD's own. */
export const siteFrom = (told: string | undefined): string => told?.trim() || POD_SITE;

/** The seat a command was told, refused in words when it is not one a pod has. */
export function roleFrom(told: string): Role {
  const role = SEATS.find((seat) => seat === told);
  if (!role) throw new CommandError("NOT_A_SEAT", `"${told}" is not a seat on a pod.`, `A pod has these seats: ${SEATS.join(", ")}.`);
  return role;
}

/** Anything thrown, as words: for refusals that came from somebody else's code. */
export const inWords = (error: unknown): string => ((error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "").replace(/\.+$/, "");
