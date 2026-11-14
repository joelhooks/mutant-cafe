import { expect, it } from "vitest";
export const testAssertion = (): boolean => true;
it("fixture assertion", () => expect(testAssertion()).toBe(true));
