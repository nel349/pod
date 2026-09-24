/**
 * Reading what an agent left in its box.
 *
 * The agent chose every byte of its workspace, so a file there is not necessarily a file: it can be a
 * link to something on this machine (the repository's .env is a few folders away), or something that
 * never ends. So a path is read only if it is a plain file, and only up to a size nothing honest
 * would reach. Anything else is treated as not there, and the caller says so in its own words.
 */
import { lstat, readFile } from "node:fs/promises";
import type { z } from "zod";

/** the most any one file from the box is trusted to hold: a check, a readback, a say.json */
export const LARGEST_FILE_FROM_THE_BOX = 256 * 1024;

/** The file's text, if it is a plain file of a sane size; nothing otherwise. */
export async function textFromTheBox(path: string): Promise<string | undefined> {
  try {
    const found = await lstat(path);
    if (!found.isFile() || found.size > LARGEST_FILE_FROM_THE_BOX) return undefined;
    return await readFile(path, "utf8");
  } catch {
    // not there: the agent left nothing at this path
    return undefined;
  }
}

/**
 * Words the model wrote for a poster to read, with its em dashes turned into commas. The model will
 * use them however it is asked; the page's rule is that none reaches a reader, so this is where they
 * are taken out.
 */
export function plainDashes(text: string): string {
  return text.replace(/\s*\u2014\s*/g, ", ");
}

/** The file, parsed and checked against a schema, because the agent wrote it; nothing if it does not fit. */
export async function jsonFromTheBox<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await textFromTheBox(path);
  if (text === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // not JSON at all, which is the same as not the shape asked for
    return undefined;
  }
}
