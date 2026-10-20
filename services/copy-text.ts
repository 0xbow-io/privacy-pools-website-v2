/**
 * Put text on the clipboard, on web or native.
 *
 * Written for the blind-deposit claim link, where "copy" is not a convenience:
 * the link is the recipient's only route to the money, and every surface that
 * offers it was web-only. A deposit confirmed on a phone left the sender with
 * a shortened preview on screen and no supported way to send the real thing
 * (codex, 2026-09-16).
 *
 * Returns whether the text actually landed, so a caller holding something
 * irreplaceable can keep offering it rather than assuming it was taken.
 * expo-clipboard is imported lazily: it is a native module, and the web
 * bundle should not carry it.
 */
import { Platform } from 'react-native';

export async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  if (Platform.OS === 'web') {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Denied permission, an unfocused document, or an insecure origin.
      return false;
    }
  }
  try {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(value);
    return true;
  } catch {
    return false;
  }
}
