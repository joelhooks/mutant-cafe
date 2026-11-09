import { expect, it } from "vitest";
export const specAssertion = (): boolean => true;
it("fixture assertion", () => expect(specAssertion()).toBe(true));
