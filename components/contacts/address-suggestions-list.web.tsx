import { useCallback, useEffect } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useFloating } from '@floating-ui/react';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { DROPDOWN_SHADOW_WEB } from '@/components/ui/web-style-shims';
import { shortAddress } from '@/services/address-book-core';
import type { AddressSuggestionsListProps } from '@/components/contacts/address-suggestions-list';

/**
 * Web: a listbox portalled to <body> and anchored to the field by Floating UI,
 * so no card, scroller or RN-Web stacking context can clip it. Focus never
 * leaves the input (every mousedown is prevented), which keeps typing to
 * filter and arrow keys working; the input owns aria-activedescendant.
 */
export function AddressSuggestionsList({ open, anchor, listId, suggestions, activeIndex, onHover, onSelect, onEdit, testID }: AddressSuggestionsListProps) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { refs, floatingStyles } = useFloating({
    open,
    placement: 'bottom-start',
    // top/left positioning, so the enter animation owns `transform`.
    transform: false,
    elements: { reference: (anchor as Element | null) ?? null },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 12 }),
      shift({ padding: 12 }),
      size({
        padding: 12,
        apply({ rects, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            width: `${Math.max(rects.reference.width, 260)}px`,
            maxHeight: `${Math.max(140, Math.min(320, availableHeight))}px`,
          });
        },
      }),
    ],
  });

  // Enter motion on mount through the Web Animations API: no state, no re-render.
  const setFloating = refs.setFloating;
  const attach = useCallback((el: HTMLDivElement | null) => {
    setFloating(el);
    el?.animate?.(
      [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
  }, [setFloating]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  if (!open || !anchor || suggestions.length === 0) return null;
  return (
    <FloatingPortal>
      <div
        ref={attach}
        id={listId}
        role="listbox"
        aria-label="Previous recipients"
        data-testid={testID ? `${testID}-suggestions` : undefined}
        onMouseDown={(e) => e.preventDefault()}
        className="overflow-y-auto rounded-[14px] border border-solid border-border-light bg-menu-background p-[5px]"
        style={{
          // nw-keep(floating-ui): Floating UI anchor position; the enter motion rides it
          ...floatingStyles,
          // nw-keep(platform-css): web-only shadow and stacking above RN-Web modals
          zIndex: 100000,
          boxShadow: DROPDOWN_SHADOW_WEB,
          outline: 'none',
        }}
      >
        {suggestions.map((s, i) => {
          const active = i === activeIndex;
          return (
            <div
              key={s.key}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={active}
              data-testid={testID ? `${testID}-suggestion-${i}` : undefined}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(s)}
              className={`group flex items-center gap-[10px] rounded-[10px] px-[9px] py-[8px] ${active ? 'bg-background-secondary' : ''}`}
              // nw-keep(platform-css): pointer cursor and hover/active background transition (web DOM row)
              style={{ cursor: 'pointer', transition: 'background-color 100ms ease-out' }}
            >
              <span
                aria-hidden
                className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-primary-soft font-pp-sans-semi-bold text-[12px] text-primary"
              >
                {s.name ? Array.from(s.name)[0]!.toUpperCase() : (
                  // nw-keep(svg-or-canvas): person glyph strokes read the primary theme token
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx={12} cy={8} r={4} />
                    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
                  </svg>
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-pp-sans-medium text-[13px] leading-[18px] text-text">
                  {s.name ?? shortAddress(s.address)}
                </span>
                {s.name ? (
                  <span className="truncate font-pp-mono text-[11px] leading-[15px] text-text-muted">{shortAddress(s.address)}</span>
                ) : null}
              </span>
              <button
                type="button"
                tabIndex={-1}
                aria-label={s.name ? `Edit name for ${s.name}` : `Name ${shortAddress(s.address)}`}
                data-testid={testID ? `${testID}-suggestion-${i}-edit` : undefined}
                onClick={(e) => { e.stopPropagation(); onEdit(s); }}
                className={`flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] bg-transparent hover:bg-card-background ${active ? 'opacity-100' : 'opacity-60'}`}
                // nw-keep(platform-css): web-only UA button reset and fade transition
                style={{ border: 'none', cursor: 'pointer', transition: 'opacity 120ms ease-out' }}
              >
                {/* nw-keep(svg-or-canvas): pencil glyph stroke reads the secondary theme token */}
                <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </FloatingPortal>
  );
}
