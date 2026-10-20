/** Ten minutes is the healthy approval window; tolerate a bounded service delay. */
export async function waitForApproval(description: string | (() => string), approved: () => Promise<boolean>) {
  const minutes = Number(process.env.E2E_APPROVAL_TIMEOUT_MINUTES ?? '45');
  if (!Number.isFinite(minutes * 60_000) || minutes < 10) throw new Error('E2E_APPROVAL_TIMEOUT_MINUTES must be at least 10');
  const started = Date.now();
  let lastProgress = 0;
  while (true) {
    const ready = await approved();
    const elapsed = Date.now() - started;
    const label = typeof description === 'function' ? description() : description;
    if (ready) {
      if (elapsed >= 600_000) console.warn(`[approval recovered] ${label} after ${(elapsed / 60_000).toFixed(1)} minutes`);
      return;
    }
    if (elapsed >= minutes * 60_000) {
      const error = new Error(`[approval timeout] ${label} still not approved after ${minutes} minutes; no dependent spend submitted`);
      error.name = 'ApprovalTimeoutError';
      throw error;
    }
    if (elapsed >= 600_000 && elapsed - lastProgress >= 60_000) {
      console.warn(`[approval delayed] ${label}: ${(elapsed / 60_000).toFixed(1)} minutes elapsed; waiting up to ${minutes}`);
      lastProgress = elapsed;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
