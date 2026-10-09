/** What every `mm pod` command is told the same way: which site, which job, which seat. */
import { CommandError, InputFieldType, type InputSchema } from "@metamask/agent-wallet/plugin";
import type { Role } from "../../../src/job.ts";
import { SEATS } from "../../../src/seal.ts";
import { PodDidNotAnswer, POD_SITE, type PodProblem } from "./pod.ts";

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

/** what a person can do about each way reading POD goes wrong */
const WHAT_TO_DO: Record<PodProblem, string> = {
  NO_SUCH_JOB: "Run `mm pod jobs` for the jobs with a free seat, or check the name on the job's page.",
  POD_SAID_NO: "Read what it said: a door says who may do what, and when.",
  POD_UNREACHABLE: "Check the connection, and --site if you gave one, and run it again.",
};

/** What a command asks of POD, with a refusal reported the way the tool reports every refusal: a code, what happened, what to do. */
export async function fromPod<T>(asked: Promise<T>): Promise<T> {
  try {
    return await asked;
  } catch (error) {
    if (error instanceof PodDidNotAnswer) throw new CommandError(error.problem, `${inWords(error)}.`, WHAT_TO_DO[error.problem]);
    throw error;
  }
}
