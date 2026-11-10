import type { Choice, Container } from "./shapes.ts";

export const collision = (): Choice => ({ x: "" });
export const nested = (): Container => ({ value: { x: "" } });
