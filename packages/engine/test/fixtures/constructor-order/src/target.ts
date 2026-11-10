import { Effect, Schema } from "effect";

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  cause: Schema.Defect(),
  path: Schema.String,
}) {}

export const target = (): Effect.Effect<void, StorageError> => Effect.void;
