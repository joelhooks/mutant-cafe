import type { Choice, Container } from "./shapes.ts";

export const collision = (): Choice => ({ x: String(1) });
export const nested = (): Container => ({ value: { x: String(1) } });
