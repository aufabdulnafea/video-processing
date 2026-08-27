import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";
import { AuthenticationError } from "../../domain/errors";

export function authenticate(req: Request): void {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new AuthenticationError("Missing or malformed Authorization header (expected: Bearer <API_KEY>)");
  }

  const expected = Buffer.from(env.API_KEY);
  const actual = Buffer.from(token);

  // Reject unequal-length inputs before timingSafeEqual, which throws on mismatched buffer
  // lengths rather than returning false.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AuthenticationError("Invalid API key");
  }
}
