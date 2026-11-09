import * as Effect from "effect/Effect";

interface First {
  readonly _tag: "First";
}

interface Second {
  readonly _tag: "Second";
}

export function target(value: string): Effect.Effect<string, First | Second> {
  return Effect.succeed(value);
}
