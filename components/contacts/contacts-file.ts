// Native: no file picker or download in this app's native build. Export goes
// through the system share sheet (save to Files, send to yourself); import is
// a paste of the file's text into the Contacts dialog.
import { Share } from 'react-native';

export const CAN_PICK_FILE = false;

export async function saveContactsFile(json: string, _filename: string): Promise<boolean> {
  try {
    const r = await Share.share({ message: json });
    return r.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}

export type PickedFile = { text: string } | { error: string } | null;

export function pickContactsFile(): Promise<PickedFile> {
  return Promise.resolve(null);
}
