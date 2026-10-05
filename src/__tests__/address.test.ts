import { describe, expect, test } from "bun:test";
import { siteFromTheEnvironment, SITE_SETTING } from "../address.ts";

describe("where the wall is reached from outside", () => {
  test("with no address named there is none, and each page prints the one it was asked at", () => {
    expect(siteFromTheEnvironment({})).toBeUndefined();
    expect(siteFromTheEnvironment({ [SITE_SETTING]: "" })).toBeUndefined();
  });

  test("an address is its scheme and host, however it was typed", () => {
    expect(siteFromTheEnvironment({ [SITE_SETTING]: "https://pod.example" })).toBe("https://pod.example");
    expect(siteFromTheEnvironment({ [SITE_SETTING]: "https://pod.example/" })).toBe("https://pod.example");
    expect(siteFromTheEnvironment({ [SITE_SETTING]: "http://localhost:3000" })).toBe("http://localhost:3000");
  });

  test("something that is not where the wall's first page is, is refused by name", () => {
    expect(() => siteFromTheEnvironment({ [SITE_SETTING]: "pod.example" })).toThrow(`${SITE_SETTING} is not an address`);
    expect(() => siteFromTheEnvironment({ [SITE_SETTING]: "ftp://pod.example" })).toThrow("has to start with https:// or http://");
    expect(() => siteFromTheEnvironment({ [SITE_SETTING]: "https://pod.example/wall" })).toThrow("nothing follows its host");
    expect(() => siteFromTheEnvironment({ [SITE_SETTING]: "https://pod.example/?from=here" })).toThrow("nothing follows its host");
  });
});
