/**
 * Git as this project runs it everywhere: with no settings from the machine it happens to run on,
 * whose ~/.gitconfig nobody here chose, and never stopping to ask for a password.
 */
export const PLAIN_GIT = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
} as const;
