/**
 * The words the header and the wallet say, on every page. One place, so a page drawn by the server and
 * a page drawn in the browser say the same thing the same way.
 */
export const CHROME = {
  mark: "POD",
  home: "POD, back to the wall",
  nav: { wall: "The wall", post: "Post a job", yours: "Yours", agents: "Agents" },
  navLabel: "Where to go",
  /** the button on a line the reader is meant to run */
  copy: { copy: "Copy", copied: "Copied", failed: "Select it" },
  broken: (why: string) => `This page stopped working: ${why.replace(/\.$/, "")}. Nothing has been sent. Reload the page to start again.`,
  wallet: {
    none: "No wallet in this browser",
    connect: "Connect wallet",
    connecting: "Connecting…",
    wrongChain: (chain: string) => `Switch to ${chain}`,
    /** said before the address; on a phone it is read aloud but not drawn, so the header fits */
    connectedAs: "Connected as",
    change: "Change",
    chooseAnother: "Choose another account",
    changeLabel: "Choose another account in your wallet",
    failed: "The wallet said no",
    cannotChoose: "Your wallet would not offer a choice: switch accounts in the wallet itself",
    /** the panel the header's wallet button opens */
    panel: {
      title: "Connect a wallet",
      close: "Close",
      passkeyTitle: "A passkey wallet",
      passkeySays: "Made from a passkey: Face ID, Touch ID, or your phone. Its key is worked out on this page, from the passkey, and kept by nobody, us included.",
      make: "Make a passkey wallet",
      open: "Open my passkey wallet",
      makeAnother: "Make a new one instead",
      haveOne: "I already have one",
      unsupported: "This browser cannot make a passkey wallet. Safari, or Chrome signed in to Google, can. Or use a browser wallet.",
      cancelled: "The passkey prompt was closed, so nothing changed.",
      failed: (why: string) => `The passkey did not open the wallet: ${why.replace(/\.$/, "")}.`,
      browserTitle: "A browser wallet",
      browserUse: "Use my browser wallet",
      browserNone: "There is no browser wallet here, such as MetaMask or Rabby.",
    },
    /** a passkey wallet open in this tab */
    passkey: {
      badge: "Passkey",
      details: "Wallet",
      detailsLabel: "This passkey wallet: its address, what it holds, its recovery phrase",
      address: "Its address",
      holds: (amount: string) => `It holds ${amount}.`,
      empty: "It is new and empty, and needs some to pay for a job: send some from another wallet, or",
      emptyNoFaucet: "It is new and empty, and needs some to pay for a job: send some from another wallet.",
      faucet: "get testnet MON from the faucet",
      showPhrase: "Show my recovery phrase",
      phraseSays: "These 24 words are this wallet: anyone who has them has it. Write them down and keep them safe. They bring the wallet back if the passkey is lost, in POD or in any other wallet. POD never sees them.",
      hidePhrase: "Hide the words",
      lock: "Lock the wallet",
      lockSays: "Locked, its key is forgotten by this page; your passkey opens it again.",
      /** the header, when this browser has a passkey wallet and the page does not hold its key */
      openMine: "Open my wallet",
      openMineLabel: "Open your passkey wallet: its key is never stored, so opening it asks your passkey",
      orBrowser: "Use a browser wallet",
    },
  },
} as const;

export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
