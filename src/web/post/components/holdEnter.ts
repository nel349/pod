import type { KeyboardEvent } from "react";

/**
 * Enter in a field of this form does not submit it. Submitting this form pays money, and a key
 * pressed out of habit at the end of a price or an address should not be how that starts: the pay
 * button is the one way to pay.
 */
export function holdEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === "Enter") event.preventDefault();
}
