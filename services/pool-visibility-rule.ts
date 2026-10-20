/** Directory exception: retain funds and the page already being viewed. */
export function poolVisible(args: { superseded: boolean; active: number; pending: number; current?: boolean }): boolean {
  return !args.superseded || args.active > 0 || args.pending > 0 || args.current === true;
}
