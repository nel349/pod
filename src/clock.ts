/** Now, in whole seconds since 1970: the unit statements, notes and the chain all count time in */
export function secondsNow(): number {
  return Math.floor(Date.now() / 1000);
}
