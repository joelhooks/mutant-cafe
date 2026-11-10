interface Policy {
  readonly egress: "open" | readonly string[];
  readonly plan: "free";
}

export const policy = (): Policy => ({ egress: "open", plan: "free" });
