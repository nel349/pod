import { describe, expect, test } from "bun:test";
import { InvalidInputRpcError, RpcRequestError } from "viem";
import { errorCode, firstLine } from "../errors.ts";

/**
 * What a person reads when something is refused.
 *
 * The one rule: say what actually happened. A chain speaks for itself, and a library's guess at what
 * a code means is not evidence. Monad answers "Signer had insufficient balance" with code -32000,
 * which viem reads as its own "Missing or invalid parameters"; a poster who is short of money and is
 * told about parameters has been sent to look in the wrong place.
 */

const refusedBy = (code: number, message: string): unknown =>
  new InvalidInputRpcError(new RpcRequestError({ body: {}, error: { code, message }, url: "http://a-node" }));

describe("what went wrong, as one line", () => {
  test("a node's own words win over the library's wording of them", () => {
    expect(firstLine(refusedBy(-32000, "Signer had insufficient balance"))).toBe("Signer had insufficient balance");
  });

  test("a plain error still reads as itself", () => {
    expect(firstLine(new Error("the door was shut"))).toBe("the door was shut");
    expect(firstLine("a string somebody threw")).toBe("a string somebody threw");
  });

  test("only the first line, and never a stack trace", () => {
    expect(firstLine(new Error("the first line\n  at somewhere:1:2"))).toBe("the first line");
  });

  test("the code is given back where there is one", () => {
    expect(errorCode(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe("ENOENT");
    expect(errorCode(new Error("no code"))).toBeUndefined();
  });
});
