export const BACKUP_PREPARATION_TIMEOUT_MS = 30_000;

/** Only bounds the caller's wait. Never clears, deletes or rewrites recovery data. */
export async function withBackupDeadline<T>(work: Promise<T>, timeoutMs = BACKUP_PREPARATION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Backup took too long. Try again. Keep your browser data.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
