/**
 * A wallet, for a test, that a page cannot tell from a real one.
 *
 * It is the browser interface every wallet extension implements, and behind it is a real chain whose
 * accounts sign for themselves. So the transaction is real, the signature is real, and the money
 * moves; what is missing is only the extension's own pop-up and a person pressing "approve" in it,
 * which is not the thing any of these tests are about.
 *
 * Like a real wallet, it can start out on some other chain, and switches when the page asks. It only
 * knows the one real chain behind it, so being asked for any other is refused the way wallets refuse
 * a chain they have not been told about.
 */
export function walletInThePage(input: {
  readonly rpc: string;
  readonly address: string;
  readonly chainId: number;
  /** the chain it says it is on when the page first asks; the chain behind it, unless a test says otherwise */
  readonly startsOn?: number;
}): string {
  return `(() => {
    const rpc = ${JSON.stringify(input.rpc)};
    const account = ${JSON.stringify(input.address)};
    const real = "0x" + (${input.chainId}).toString(16);
    let current = "0x" + (${input.startsOn ?? input.chainId}).toString(16);
    let id = 0;
    const forward = async (method, params) => {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      const answer = await response.json();
      if (answer.error) {
        const error = new Error(answer.error.message);
        error.code = answer.error.code;
        throw error;
      }
      return answer.result;
    };
    const listeners = {};
    const emit = (event, value) => (listeners[event] ?? []).forEach((listener) => listener(value));
    window.ethereum = {
      isTestWallet: true,
      async request({ method, params }) {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts": return [account];
          case "eth_chainId": return current;
          case "wallet_switchEthereumChain": {
            const wanted = params?.[0]?.chainId?.toLowerCase();
            if (wanted !== real) { const error = new Error("Unrecognized chain"); error.code = 4902; throw error; }
            current = real;
            emit("chainChanged", current);
            return null;
          }
          case "wallet_addEthereumChain": return null;
          default:
            // a transaction sent while on the wrong chain is refused, as a real wallet would
            if (method === "eth_sendTransaction" && current !== real) {
              const error = new Error("the wallet is on another chain"); error.code = 4901; throw error;
            }
            return forward(method, params);
        }
      },
      on(event, listener) { (listeners[event] ??= []).push(listener); },
      removeListener(event, listener) { listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener); },
    };
  })();`;
}
