// Web specimen of the Floating UI cell (the .web.tsx half of the platform
// split — the DOM-oriented hook never runs on native). Both halves render the
// SAME text and cosmetics; the StyleSheet half uses inline styles, the
// className half uses classes for cosmetics while floatingStyles stays an
// inline style (nw-keep: floating-ui). With preflight OFF, raw-DOM borders
// need an explicit border style — border-solid below is the enforced
// convention (audit rule raw-dom-border-style), and the harness asserts the
// border actually renders (CONFIG-02 web proof).
import { StyleSheet, View } from 'react-native';
import { useFloating, offset, flip, shift, autoUpdate } from '@floating-ui/react';

function AnchoredPanel({ variant }: { variant: 'ss' | 'nw' }) {
  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 12 }), shift({ padding: 12 })],
  });
  if (variant === 'ss') {
    return (
      <>
        <div
          ref={refs.setReference}
          data-testid="nwg-float-anchor-ss"
          style={{ display: 'inline-block', background: '#4f46e5', color: '#fff', fontSize: 12, lineHeight: '16px', padding: '4px 8px', borderRadius: 4 }}
        >
          anchor
        </div>
        <div
          ref={refs.setFloating}
          data-testid="nwg-float-panel-ss"
          style={{
            ...floatingStyles,
            background: '#ffffff',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            padding: 8,
            fontSize: 12,
            lineHeight: '16px',
            color: '#111827',
            zIndex: 50,
          }}
        >
          floating panel
        </div>
      </>
    );
  }
  return (
    <>
      <div
        ref={refs.setReference}
        data-testid="nwg-float-anchor-nw"
        className="inline-block rounded bg-indigo-600 px-2 py-1 text-xs leading-4 text-white"
      >
        anchor
      </div>
      <div
        ref={refs.setFloating}
        data-testid="nwg-float-panel-nw"
        style={floatingStyles}
        className="z-50 rounded border border-solid border-gray-300 bg-white p-2 text-xs leading-4 text-gray-900"
      >
        floating panel
      </div>
    </>
  );
}

export function FloatingProbe({ variant }: { variant: 'ss' | 'nw' }) {
  return (
    <View style={styles.zone} testID={variant === 'ss' ? 'nwg-float-ss' : 'nwg-float-nw'}>
      <AnchoredPanel variant={variant} />
    </View>
  );
}

const styles = StyleSheet.create({
  zone: { minHeight: 72, alignItems: 'flex-start' },
});
