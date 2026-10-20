/** Standalone journeys approve normally; CI releases spends only after all fixtures approve. */
export async function fixtureBarrier(approve: () => Promise<unknown>): Promise<void> {
  if (process.env.E2E_OVERLAP_FIXTURES !== '1') { await approve(); return; }
  if (!process.send) throw new Error('Fixture coordination requires a CI IPC channel');
  const { promise: permission, resolve: release } = Promise.withResolvers<boolean>();
  const message = (value: unknown) => {
    if (value === 'run' || value === 'cancel') release(value === 'run');
  };
  const disconnected = () => release(false);
  process.on('message', message);
  process.once('disconnect', disconnected);
  try {
    process.send('seeded');
    await approve();
    process.send('ready');
    if (!(await permission)) throw new Error('Fixture execution cancelled by CI');
  } finally {
    process.off('message', message);
    process.off('disconnect', disconnected);
    if (process.connected) process.disconnect();
  }
}
