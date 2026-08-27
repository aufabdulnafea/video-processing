import { corsAllowedOrigins } from "../../config/env";

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !corsAllowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Credentials": "true",
  };
}

/** Adds an explicit OPTIONS preflight handler to every route path, reflecting only configured origins. */
export function withCorsPreflight<T extends Record<string, Record<string, unknown>>>(routes: T): T {
  const withOptions: Record<string, Record<string, unknown>> = {};

  for (const [path, methods] of Object.entries(routes)) {
    const allowedMethods = Object.keys(methods).join(", ");

    withOptions[path] = {
      ...methods,
      OPTIONS: (req: Request) =>
        new Response(null, {
          status: 204,
          headers: {
            ...corsHeadersFor(req),
            "Access-Control-Allow-Methods": `${allowedMethods}, OPTIONS`,
            "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
            "Access-Control-Max-Age": "600",
          },
        }),
    };
  }

  return withOptions as T;
}
