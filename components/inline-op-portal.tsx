import type { ReactNode } from 'react';

export const INLINE_OP_HOST_ID = 'pp-inline-op-host';

/** Native no-op — inline (modal-less) operations are a desktop-web surface;
 *  native keeps the sheet/modal presentation. */
export function InlineOpPortal(_props: { children: ReactNode }) {
  return null;
}
