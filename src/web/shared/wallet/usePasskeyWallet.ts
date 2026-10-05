import { useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { connect, disconnect, getConnection } from "wagmi/actions";
import { isMeraError } from "@category-labs/mera";
import { firstLine } from "../../../errors.ts";
import { SHARED_QUERY_KEYS } from "../queryKeys.ts";
import {
  canMakePasskeyWallets, endPasskeyWallet, hasRememberedPasskey, heldPasskeyWallet, holdPasskeyWallet, makePasskeyWallet,
  onPasskeyWalletChange, openPasskeyWallet, PASSKEY_CONNECTOR_ID, readRecoveryPhrase, type OpenPasskeyWallet,
} from "./passkey/index.ts";

/** Why a passkey prompt did not give a wallet, as the person reads it. */
export type PasskeyProblem = "unsupported" | "cancelled" | "other";

export interface PasskeyWallet {
  /** whether this browser can make one, as far as it says before trying; undefined while asking */
  readonly isPossible: boolean | undefined;
  /** whether a passkey wallet was made or opened in this browser before, so opening is the first offer */
  readonly isRemembered: boolean;
  /** the wallet open in this tab, if one is */
  readonly open: OpenPasskeyWallet | undefined;
  readonly make: () => void;
  readonly openAgain: () => void;
  readonly signOut: () => void;
  readonly readPhrase: () => void;
  /** the recovery phrase, after the person asked to see it and passed the prompt; forgotten when hidden */
  readonly phrase: string | undefined;
  readonly hidePhrase: () => void;
  readonly isBusy: boolean;
  readonly problem: { readonly kind: PasskeyProblem; readonly why: string } | undefined;
}

/** A failed prompt, sorted: the authenticator cannot do this, the person said no, or something else. */
function problemOf(error: unknown): { readonly kind: PasskeyProblem; readonly why: string } {
  if (isMeraError(error) && error.code === "PRF_UNAVAILABLE") return { kind: "unsupported", why: firstLine(error) };
  if (isMeraError(error) && error.code === "PASSKEY_OPERATION_FAILED") return { kind: "cancelled", why: firstLine(error) };
  return { kind: "other", why: firstLine(error) };
}

/** The passkey wallet: making one, opening it in this tab, ending it, and reading its recovery phrase. */
export function usePasskeyWallet(): PasskeyWallet {
  const config = useConfig();
  const open = useSyncExternalStore(onPasskeyWalletChange, heldPasskeyWallet, () => undefined);
  const possible = useQuery({ queryKey: SHARED_QUERY_KEYS.passkeyPossible(), queryFn: canMakePasskeyWallets, staleTime: Infinity });
  const [phrase, setPhrase] = useState<string>();
  const connector = config.connectors.find((one) => one.id === PASSKEY_CONNECTOR_ID);

  /** Hold the wallet, then connect it, so every page signs with it from now on. */
  const useIt = async (wallet: OpenPasskeyWallet): Promise<void> => {
    holdPasskeyWallet(wallet);
    if (getConnection(config).status === "connected") await disconnect(config);
    if (!connector) throw new Error("this page has no passkey connector");
    await connect(config, { connector });
  };

  const making = useMutation({ mutationFn: async () => useIt(await makePasskeyWallet()) });
  const opening = useMutation({ mutationFn: async () => useIt(await openPasskeyWallet()) });
  const reading = useMutation({ mutationFn: readRecoveryPhrase, onSuccess: setPhrase });
  const failed = making.error ?? opening.error ?? reading.error;

  return {
    isPossible: possible.data,
    isRemembered: open !== undefined || hasRememberedPasskey(),
    open,
    make: () => { opening.reset(); making.mutate(); },
    openAgain: () => { making.reset(); opening.mutate(); },
    signOut: () => {
      setPhrase(undefined);
      endPasskeyWallet();
      void disconnect(config);
    },
    readPhrase: () => reading.mutate(),
    phrase,
    hidePhrase: () => setPhrase(undefined),
    isBusy: making.isPending || opening.isPending || reading.isPending,
    problem: failed ? problemOf(failed) : undefined,
  };
}
