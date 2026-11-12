export type StellarRegistrationPrompt = { address: string; finish?: boolean; error?: string; pending?: boolean };
export class StellarRegistrationCancelledError extends Error {
  constructor() { super('Stellar registration cancelled. Start again when you are ready.'); }
}
const cancelled = () => new StellarRegistrationCancelledError();

/** Presents consent and progress; execution stays inside the account queue. */
export class StellarRegistrationPrompts {
  private host: ((prompt: StellarRegistrationPrompt | null) => void) | null = null;
  private allowed: ((address: string) => boolean) | null = null;
  private pending: ((approved: boolean) => void) | null = null;
  private epoch = 0;
  private prompt: StellarRegistrationPrompt | null = null;

  attach(host: (prompt: StellarRegistrationPrompt | null) => void, allowed: (address: string) => boolean) {
    this.cancel();
    this.host = host;
    this.allowed = allowed;
    return () => {
      this.cancel();
      this.host = null;
      this.allowed = null;
    };
  }

  cancel = () => {
    this.epoch++;
    const settle = this.pending;
    this.pending = null;
    this.finish();
    settle?.(false);
  };

  approve = () => {
    const settle = this.pending;
    if (!settle || !this.prompt) return;
    this.pending = null;
    this.prompt = { ...this.prompt, pending: true, error: undefined };
    this.host?.(this.prompt);
    settle(true);
  };

  finish = () => {
    this.prompt = null;
    this.host?.(null);
  };

  async request(prompt: StellarRegistrationPrompt, shouldContinue: () => boolean): Promise<() => void> {
    if (!this.host || !this.allowed?.(prompt.address) || this.pending) throw cancelled();
    const epoch = this.epoch;
    const assertActive = () => {
      if (epoch !== this.epoch || !this.allowed?.(prompt.address) || !shouldContinue()) throw cancelled();
    };
    assertActive();
    const approved = await new Promise<boolean>((resolve) => {
      this.pending = resolve;
      this.prompt = prompt;
      this.host?.(prompt);
    });
    if (!approved) throw cancelled();
    assertActive();
    return assertActive;
  }
}

export const stellarRegistrationPrompts = new StellarRegistrationPrompts();
