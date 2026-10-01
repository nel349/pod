/**
 * What other pages may use of the posting page: the payment it keeps in the browser until its job is
 * published, or on a contract that prepares jobs until the job is set up, which your own page shows.
 * Everything else here is the posting page's own.
 */
export { keptPaymentStore } from "./hooks/keptPaymentStore.ts";
export { keptSetUpStore } from "./hooks/keptSetUpStore.ts";
export type { Kept } from "./state/keptPayment.ts";
export type { KeptSetUp } from "./state/payFirst.ts";
