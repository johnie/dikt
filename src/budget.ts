export class Budget {
  readonly maximum: number | undefined;
  private admitted = 0;
  private knownCost = 0;
  private unknownCost = false;

  constructor(maximum: number | undefined) {
    if (maximum !== undefined && (!Number.isFinite(maximum) || maximum < 0)) {
      throw new Error("--max-cost must be a finite, nonnegative USD amount");
    }
    this.maximum = maximum;
  }

  reserve(estimate: number | null, description: string): void {
    if (this.maximum !== undefined) {
      if (this.unknownCost) {
        throw new Error(
          `Cannot admit ${description}: prior request cost is unknown`
        );
      }
      if (estimate === null || !Number.isFinite(estimate) || estimate < 0) {
        throw new Error(
          `Cannot estimate ${description}; --max-cost blocks unknown pricing`
        );
      }
      if (
        Math.max(this.admitted, this.knownCost) + estimate >
        this.maximum + Number.EPSILON
      ) {
        throw new Error(
          `Estimated budget exceeded before ${description}: $${(Math.max(this.admitted, this.knownCost) + estimate).toFixed(4)} > $${this.maximum.toFixed(4)}`
        );
      }
    }
    this.admitted = Math.max(this.admitted, this.knownCost) + (estimate ?? 0);
  }

  record(cost: number | null): void {
    if (cost === null) {
      this.unknownCost = true;
    } else {
      this.knownCost += cost;
    }
  }

  describe(): string {
    return this.unknownCost
      ? `reported spend at least $${this.knownCost.toFixed(4)} (some costs unknown)`
      : `reported spend $${this.knownCost.toFixed(4)}`;
  }
}
