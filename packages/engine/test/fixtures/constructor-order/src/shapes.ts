export interface Broad {
  readonly x: string;
}

export interface Narrow {
  readonly x: "";
}

export type Choice = Narrow | Broad;

export interface Container {
  readonly value: Choice;
}
