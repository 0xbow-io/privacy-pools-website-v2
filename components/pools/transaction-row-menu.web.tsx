import { useState } from 'react';
import {
  useFloating,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
  FloatingFocusManager,
  offset,
  flip,
  shift,
  autoUpdate,
} from '@floating-ui/react';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { DROPDOWN_SHADOW_WEB } from '@/components/ui/web-style-shims';
import { WarningTriangleHint } from '@/components/ui/explorer-privacy-hint';

export type TransactionRowMenuItem = {
  key: string;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  color?: string;
  /** DEV-573: a privacy note shown under the label (red), e.g. on explorer links. */
  warning?: string;
};

export type TransactionRowMenuProps = {
  items: TransactionRowMenuItem[];
};

// Web version uses Floating UI so the menu stays anchored to its trigger on
// scroll / resize, flips when close to the viewport edge, and portals to
// <body> to escape any overflow/stacking context from parent cards.
export function TransactionRowMenu({ items }: TransactionRowMenuProps) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [open, setOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 12 }), shift({ padding: 12 })],
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([click, dismiss, role]);

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        aria-label="Transaction actions"
        className="inline-flex items-center justify-center rounded-card bg-background-secondary p-[4px]"
        // nw-keep(platform-css): web-only reset of the UA button chrome — no border, pointer cursor
        style={{ border: 'none', cursor: 'pointer' }}
      >
        {/* nw-keep(svg-or-canvas): dot glyph fills read the muted theme token into the raw <circle> fills */}
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx={8} cy={3} r={1.5} fill={colors.textSecondary} />
          <circle cx={8} cy={8} r={1.5} fill={colors.textSecondary} />
          <circle cx={8} cy={13} r={1.5} fill={colors.textSecondary} />
        </svg>
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              className="z-[1000] min-w-[200px] rounded-card border border-solid border-border-light bg-menu-background p-[6px]"
              style={{
                // nw-keep(floating-ui): Floating UI computed anchor position (inset/transform) — runtime, no className path
                ...floatingStyles,
                // nw-keep(platform-css): web-only elevation (the shared dropdown shadow) + focus-ring reset on the portalled menu
                boxShadow: DROPDOWN_SHADOW_WEB,
                outline: 'none',
              }}
              {...getFloatingProps()}
            >
              {items.map((item, idx) => (
                <button
                  key={item.key}
                  type="button"
                  {...getItemProps({
                    onClick: () => {
                      setOpen(false);
                      item.onPress();
                    },
                  })}
                  role="menuitem"
                  tabIndex={idx === 0 ? 0 : -1}
                  className="flex w-full items-center gap-[10px] rounded-pill bg-transparent px-[12px] py-[10px] text-left font-pp-regular text-[14px] hover:bg-background-secondary"
                  // nw-keep(platform-css): web-only UA button reset (no border, pointer cursor)
                  // nw-keep(data-color): per-item override color (or theme token fallback) — runtime value, not a class token
                  style={{ border: 'none', cursor: 'pointer', color: item.color ?? colors.text }}
                >
                  {item.warning ? <WarningTriangleHint text={item.warning} size={16} /> : item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
