// Web: download a file and read one back through the browser's file picker.
// Nothing is uploaded; the picked file is read locally with FileReader.
import { MAX_IMPORT_BYTES } from '@/services/address-book-core';

export const CAN_PICK_FILE = true;

export async function saveContactsFile(json: string, filename: string): Promise<boolean> {
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}

export type PickedFile = { text: string } | { error: string } | null;

/** The picked file's text, a plain error, or null when nothing was picked. */
export function pickContactsFile(): Promise<PickedFile> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json,text/csv,.csv';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      // Refuse before reading: the size check in the parser is the backstop.
      if (file.size > MAX_IMPORT_BYTES) { resolve({ error: 'This file is too large. Contacts files are under 256 KB.' }); return; }
      const reader = new FileReader();
      reader.onload = () => resolve({ text: typeof reader.result === 'string' ? reader.result : '' });
      reader.onerror = () => resolve({ error: 'This file could not be read.' });
      reader.readAsText(file);
    };
    input.click();
  });
}
