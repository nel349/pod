import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readableToTheBox } from "../../sandbox.ts";

/**
 * A directory shaped like a checkout: readable by whoever runs the box.
 *
 * The sealed containers drop every capability, including the one that lets root ignore file modes,
 * so a directory only its owner can read is a directory the box cannot open. `mkdtemp` makes exactly
 * that (0700), which passed on a Mac, where the file sharing layer ignores modes, and failed on
 * Linux CI with the artefact dying on its first command. A real job arrives from a git checkout,
 * which is world-readable, so that is what the fixtures are.
 */
export async function checkout(prefix: string, files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  return readableToTheBox(directory);
}
