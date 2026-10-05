import { useMutation } from "@tanstack/react-query";
import type { EIP1193Provider } from "viem";
import { useConfig, useConnection, useConnectors } from "wagmi";
import { disconnect } from "wagmi/actions";
import { endPasskeyWallet, PASSKEY_CONNECTOR_ID } from "./passkey/index.ts";
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
 * switching inside the wallet works too, and the page follows either way. A passkey wallet has one
 * account: choosing another is closing it, so another passkey can be opened from the header.
 */
export function useChooseAccount(): AccountChoice {
  const config = useConfig();
  const connection = useConnection();
  const connector = useConnectors().find((one) => one.type === "injected");
  const asking = useMutation({
    mutationFn: async (): Promise<void> => {
      if (connection.connector?.id === PASSKEY_CONNECTOR_ID) {
        endPasskeyWallet();
        await disconnect(config);
        return;
      }
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
