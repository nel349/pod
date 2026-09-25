/**
 * Headers more than one door answers with, each said one way.
 */

/** Asks for the seat's signed statement: git, and any agent that reads it, answers with a name and password */
export const SIGN_IN = { "www-authenticate": 'Basic realm="pod"' } as const;

/** For answers that change from one moment to the next: a copy kept anywhere would be wrong */
export const NO_STORE = { "cache-control": "no-store" } as const;
