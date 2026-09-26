/**
 * The script that takes the site pages over in the browser, built from `client.tsx` by Bun when it is
 * first asked for. Kept once built in production; built again each time while developing, so an edit
 * shows on the next reload. Nothing built is ever committed.
 */
const ENTRY = new URL("./client.tsx", import.meta.url).pathname;

let built: Promise<string> | undefined;

async function build(isProduction: boolean): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: "browser",
    minify: isProduction,
    define: { "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development") },
  });
  const [output] = result.outputs;
  if (!result.success || !output) {
    throw new Error(`the site script did not build: ${result.logs.map((log) => log.message).join("; ")}`);
  }
  return await output.text();
}

export function siteScript(isProduction: boolean): Promise<string> {
  if (!isProduction) return build(false);
  built ??= build(true).catch((error: unknown) => {
    // a failed build is not kept, so the next request tries again rather than failing forever
    built = undefined;
    throw error;
  });
  return built;
}
