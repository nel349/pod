/**
 * What each server-drawn page shows, worked out from a job's record, as plain data.
 *
 * The same data draws the page on the server and brings it to life in the browser, so both say exactly
 * the same thing. It crosses the network, in the page and from the job's own address as it is
 * followed, so it is a schema: the browser reads it through these rather than trusting it. Money is in
 * wei as a decimal string and times are ISO strings, because JSON has neither.
 */
export * from "./job.ts";
export * from "./kinds.ts";
export * from "./money.ts";
export * from "./receipt.ts";
export * from "./site.ts";
export * from "./tile.ts";
export * from "./yours.ts";
