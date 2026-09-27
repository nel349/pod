import { useMutation } from "@tanstack/react-query";
import type { EIP1193Provider } from "viem";
import { useConnectors } from "wagmi";
import { firstLine } from "../../../errors.ts";

/** Whether what a connector handed back is a wallet that can be asked things. */
function isAWallet(provider: unknown): provider is EIP1193Provider {
  return typeof provider === "object" && provider !== null && "request" in provider && typeof provider.request === "function";
}

export interface AccountChoice {
  readonly choose: () => void;
  readonly isChoosing: boolean;
  /** why the wallet would not let an account be chosen, such as it having no such request */
  readonly why: string | undefined;
}

/**
 * Ask the wallet to let the person pick which of their accounts this site sees. A wallet holding
 * several accounts connects with whichever was chosen last, which is often not the one that paid;
 * switching inside the wallet works too, and the page follows either way.
 */
export function useChooseAccount(): AccountChoice {
  const [connector] = useConnectors();
  const asking = useMutation({
    mutationFn: async (): Promise<void> => {
      const provider: unknown = await connector?.getProvider();
      if (!isAWallet(provider)) throw new Error("there is no wallet in this browser to ask");
      await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    },
  });
  return {
    choose: () => asking.mutate(),
    isChoosing: asking.isPending,
    why: asking.error ? firstLine(asking.error) : undefined,
  };
}
