/**
 * The tools some tests need, and whether this machine has them.
 *
 * A test without its tool is skipped, which is right on a laptop that has no Docker. On CI it is
 * wrong: every tool a test needs is installed there on purpose, and one that went missing would turn
 * the tests that need it into tests that ran nothing and passed. So on CI a missing tool is a failure.
 */

export function neededOnCI(tool: string, isHere: boolean): boolean {
  if (!isHere && process.env.CI === "true") {
    throw new Error(`${tool} is not on this CI machine, so the tests that need it would skip and prove nothing`);
  }
  return isHere;
}

export async function dockerAvailable(): Promise<boolean> {
  let isHere = false;
  try {
    isHere = (await Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
  } catch {
    isHere = false;
  }
  return neededOnCI("Docker", isHere);
}
