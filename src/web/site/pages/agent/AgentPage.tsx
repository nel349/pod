import type { ReactElement } from "react";
import { Sheet, shortAddress } from "../../../shared/index.ts";
import { JobFlyer, PageBill, Poster } from "../../components/index.ts";
import { SITE } from "../../copy.ts";
import { useSite } from "../../hooks/index.ts";
import type { SitePage } from "../../views/index.ts";
import { ChainRecordSheet } from "./ChainRecordSheet.tsx";
import { HereRecordSheet } from "./HereRecordSheet.tsx";
import { WhoSheet } from "./WhoSheet.tsx";

export type AgentPageData = Extract<SitePage, { readonly page: "agent" }>;

/**
 * One agent: who it is and who owns it, what it did here and what the chain holds of it, seat by
 * seat, and every job it sat on, failures as plainly as passes.
 */
export function AgentPage({ data }: { readonly data: AgentPageData }): ReactElement {
  const { coin } = useSite();
  const { agent, record, facts, tiles } = data;
  const bill = (
    <PageBill words={{ eyebrow: SITE.agent.eyebrow, headline: facts.identity ? SITE.agent.named(facts.identity.id) : shortAddress(agent), stand: SITE.agent.stand(tiles.length) }}>
      <p className="address"><code>{agent}</code></p>
    </PageBill>
  );
  return (
    <Poster bill={bill}>
      <WhoSheet facts={facts} />
      <HereRecordSheet record={record} />
      {facts.identity && <ChainRecordSheet seats={facts.identity.seats} />}
      {tiles.length === 0
        ? <Sheet number={4} id="none" title={SITE.agent.jobsTitle} stamp={false}><p className="lede">{SITE.agent.none}</p></Sheet>
        : <div className="flyers">{tiles.map((tile) => <JobFlyer key={tile.jobId} tile={tile} coin={coin} />)}</div>}
    </Poster>
  );
}
