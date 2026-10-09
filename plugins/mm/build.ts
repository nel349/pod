/**
 * Builds the plugin: each command as one file under dist/commands, which is where MetaMask's tool
 * looks for them, with what they share beside them. POD's own modules are built in, so the sentences
 * a seat signs and the calls it makes are the very ones POD's server checks; MetaMask's tool is left
 * out, because the tool that loads the plugin is the one it has to talk to.
 */
import { rm } from "node:fs/promises";
import { Glob } from "bun";

const here = new URL(".", import.meta.url).pathname;
await rm(`${here}dist`, { recursive: true, force: true });
const commands = [...new Glob("src/commands/**/*.ts").scanSync(here)].map((path) => `${here}${path}`);
const built = await Bun.build({
  entrypoints: commands,
  root: `${here}src`,
  outdir: `${here}dist`,
  target: "node",
  format: "esm",
  splitting: true,
  external: ["@metamask/agent-wallet", "@metamask/agent-wallet/plugin"],
  naming: { entry: "[dir]/[name].js", chunk: "shared/[name]-[hash].js" },
});
if (!built.success) {
  for (const problem of built.logs) console.error(problem);
  process.exit(1);
}
console.log(`built ${commands.length} commands`);
