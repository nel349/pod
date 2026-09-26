import type { ReactElement } from "react";
import { Sheet } from "../../../shared/index.ts";
import { SITE } from "../../copy.ts";

/** Before a wallet is connected: your page is found by it, and nothing else. */
export function ConnectSheet(): ReactElement {
  return <Sheet number={2} id="connect" title={SITE.yours.connectTitle} stamp={false}><p className="lede">{SITE.yours.connect}</p></Sheet>;
}
