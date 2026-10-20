// Proof that a backup file was written. PURE (no react-native import, the
// browser global is passed in) so bun tests drive the exact code the app runs.
//
// An anchor download proves nothing: Chrome drops a gesture-less one
// silently, and a "where to save" prompt can be cancelled, all without the
// click throwing. The File System Access picker can: it hands back a file
// handle only after the user chose a location, and a write through it
// resolves only once the bytes are flushed.
//
// The picker needs a user gesture, but the write does not. So a flow whose
// file content does not exist yet at the press (creating an unregistered
// request) opens the target AT the press and writes it later.

type Writable = { write(data: string): Promise<void>; close(): Promise<void> };
export type BackupFileTarget = { createWritable(): Promise<Writable> };
type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<BackupFileTarget>;

export type PickerHost = { showSaveFilePicker?: unknown } | undefined;

/** Whether `host` (the window) can confirm a save. Synchronous on purpose. */
export function canProveSave(host: PickerHost): boolean {
  return !!host && typeof host.showSaveFilePicker === 'function';
}

/**
 * Open the save target. MUST be called synchronously from the press: the
 * picker needs the gesture. Resolves to the target, 'cancelled' when the user
 * dismissed the dialog, or null when no proof is possible (no picker, or it
 * refused) and the caller should fall back to its plain download.
 */
export function openBackupFileTarget(host: PickerHost, suggestedName: string): Promise<BackupFileTarget | 'cancelled' | null> {
  if (!canProveSave(host)) return Promise.resolve(null);
  let pending: Promise<BackupFileTarget>;
  try {
    pending = (host!.showSaveFilePicker as SaveFilePicker).call(host, {
      suggestedName,
      types: [{ description: 'Backup', accept: { 'application/json': ['.json'] } }],
    });
  } catch {
    return Promise.resolve(null);
  }
  return pending.then(
    (target) => target,
    (err) => ((err as { name?: string } | null)?.name === 'AbortError' ? 'cancelled' as const : null),
  );
}

/** Write `text` to an opened target. True only once the write is flushed. */
export async function writeBackupFileTarget(target: BackupFileTarget, text: string): Promise<boolean> {
  try {
    const writable = await target.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

/** Open and write in one go, for a press whose content already exists. */
export async function saveWithProof(
  host: PickerHost,
  text: string,
  suggestedName: string,
): Promise<'saved' | 'cancelled' | 'unproven'> {
  const target = await openBackupFileTarget(host, suggestedName);
  if (target === 'cancelled') return 'cancelled';
  if (!target) return 'unproven';
  return (await writeBackupFileTarget(target, text)) ? 'saved' : 'unproven';
}
