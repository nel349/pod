import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Address } from "viem";
import { useConfig } from "wagmi";
import { connect, getConnection, signMessage } from "wagmi/actions";
import { firstLine } from "../../../errors.ts";
import { claimToSign } from "../../../messages.ts";
import { claimApiPath } from "../../../routes.ts";
import { readAnswer } from "../../post/hooks/index.ts";
import { injectedConnector } from "../../post/wallet/index.ts";
import { ClaimedSchema, WhySchema, type Claimable, type ClaimStatus, type ClaimStep } from "../state/index.ts";
import { CLAIM_QUERY_KEYS } from "./queryKeys.ts";

/**
 * Claiming: connect the wallet, sign the sentence, and send it. The server checks the signature
 * against the chain and asks GitHub; what comes back is said as it is.
 */
export function useClaim(claimable: Claimable): { readonly status: ClaimStatus; readonly claim: (toAccount: string) => void } {
  const config = useConfig();
  const client = useQueryClient();
  const [status, setStatus] = useState<ClaimStatus>({ kind: "idle" });
  // the step under way, so a claim that stops says where
  const step = useRef<ClaimStep>("wallet");
  const doing = (next: ClaimStep): void => {
    step.current = next;
    setStatus({ kind: "working", step: next });
  };

  const claiming = useMutation({
    mutationFn: async (toAccount: string) => {
      doing("wallet");
      const account = await connected(config);
      doing("sign");
      const signature = await signMessage(config, {
        account,
        message: claimToSign({ jobId: claimable.jobId, tokenId: BigInt(claimable.tokenId), toAccount }),
      });
      doing("github");
      const response = await fetch(claimApiPath(claimable.jobId), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ toAccount, signature }),
      });
      if (!response.ok) throw new Error((await readAnswer(response, WhySchema)).why);
      return (await readAnswer(response, ClaimedSchema)).invited;
    },
    onSuccess: (invited) => {
      setStatus({ kind: "sent", invited });
      void client.invalidateQueries({ queryKey: CLAIM_QUERY_KEYS.claimable(claimable.jobId) });
    },
    onError: (error) => setStatus({ kind: "stopped", step: step.current, why: firstLine(error) }),
  });

  return { status, claim: (toAccount) => claiming.mutate(toAccount) };
}

/** The wallet's current account, connecting first if it is not connected yet. */
async function connected(config: ReturnType<typeof useConfig>): Promise<Address> {
  const connection = getConnection(config);
  if (connection.status === "connected") return connection.address;
  const [account] = (await connect(config, { connector: injectedConnector(config) })).accounts;
  if (!account) throw new Error("the wallet did not give an address");
  return account;
}
