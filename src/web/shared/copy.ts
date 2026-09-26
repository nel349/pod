/**
 * The words the header and the wallet say, on every page. One place, so a page drawn by the server and
 * a page drawn in the browser say the same thing the same way.
 */
export const CHROME = {
  mark: "POD",
  home: "POD, back to the wall",
  nav: { wall: "The wall", post: "Post a job", yours: "Yours" },
  navLabel: "Where to go",
  broken: (why: string) => `This page stopped working: ${why.replace(/\.$/, "")}. Nothing has been sent. Reload the page to start again.`,
  wallet: {
    none: "No wallet in this browser",
    connect: "Connect wallet",
    connecting: "Connecting…",
    wrongChain: (chain: string) => `Switch to ${chain}`,
    connectedAs: (short: string) => `Connected as ${short}`,
    failed: "The wallet said no",
  },
} as const;

export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
