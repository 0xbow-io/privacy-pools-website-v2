import { Platform } from 'react-native';

/**
 * Whether this surface can host modal-less (inline) operations: the desktop
 * vault home's action hub. Mobile keeps the bottom sheets. The OPENER
 * decides — providers only go inline when
 * the hub asked for it AND this capability holds, so deep links and pool-page
 * buttons keep their overlay presentation.
 */
export function useInlineOpsCapable(): boolean {
  // Every width: mobile drops the form drawers too — the sheets are only
  // used to present an operation's PROGRESS/SUCCESS while it executes.
  return Platform.OS === 'web';
}
