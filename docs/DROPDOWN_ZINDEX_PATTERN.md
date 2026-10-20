# Dropdown Z-Index Pattern

Dropdowns in this app use a specific stacking context pattern to ensure they render above sibling content. All three layers are required.

## The Pattern

### 1. Parent container of the dropdown trigger
Must establish a high stacking context so the dropdown escapes sibling elements below it.

```tsx
parentContainer: {
  position: 'relative',
  zIndex: 99999,
  overflow: 'visible',
},
```

### 2. All ancestor Views between the dropdown and the Card
Any `View` that sits between the dropdown and the outermost `Card` also needs `zIndex` and `overflow: 'visible'`. Without this, the dropdown gets clipped or layered behind sibling sections.

```tsx
header: {
  // ... layout styles
  zIndex: 99999,
  overflow: 'visible',
},
```

The Card itself also needs:
```tsx
<Card noPadding style={{ overflow: 'visible', zIndex: 100 }}>
```

### 3. Overlay (click-away backdrop)
A fixed full-screen pressable that closes the dropdown when clicking outside.

```tsx
overlay: {
  position: 'fixed' as any,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 9998,
},
```

### 4. The dropdown itself
Absolutely positioned relative to the trigger, with high z-index.

```tsx
dropdown: {
  position: 'absolute',
  top: 28,          // just below the trigger button
  right: 0,
  minWidth: 160,
  borderRadius: 0,
  borderWidth: 1,
  zIndex: 99999,
  elevation: 99999,
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.1,
  shadowRadius: 8,
},
```

### 5. Dropdown items
Each item gets an explicit background color to prevent transparency.

```tsx
<Pressable style={[styles.dropdownItem, { backgroundColor: colors.cardBackground }]}>
```

## Full JSX Example

```tsx
<View style={styles.parentContainer}>
  <Pressable onPress={() => setOpen(!open)}>
    {/* trigger content */}
  </Pressable>
  {open && (
    <>
      <Pressable style={styles.overlay} onPress={() => setOpen(false)} />
      <View style={[styles.dropdown, { backgroundColor: colors.cardBackground, borderColor: colors.border }]}>
        <Pressable style={[styles.dropdownItem, { backgroundColor: colors.cardBackground }]} onPress={() => setOpen(false)}>
          <Text style={[styles.dropdownText, { color: colors.text, fontFamily: Fonts.regular }]}>
            Option
          </Text>
        </Pressable>
      </View>
    </>
  )}
</View>
```

### 6. Decorative lines (borders, dividers) must use `zIndex: -1`
In React Native Web, CSS `borderWidth` on a sibling View or a row divider can paint **above** the dropdown if it comes later in the DOM. **Never use `borderTopWidth` / `borderBottomWidth` on siblings of the dropdown container.** Instead, render borders as separate absolutely-positioned Views with `zIndex: -1`.

**Footer border — wrong:**
```tsx
footer: {
  borderTopWidth: 1,
  padding: 12,
},
```

**Footer border — correct:**
```tsx
<View style={styles.footer}>
  <View style={[styles.footerBorder, { backgroundColor: colors.borderLight }]} />
  <Text>Show more</Text>
</View>

footer: {
  position: 'relative',
  padding: 12,
},
footerBorder: {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 1,
  zIndex: -1,
},
```

**Row dividers** between table rows also need negative z-index:
```tsx
rowDivider: {
  height: 1,
  alignSelf: 'stretch',
  position: 'relative',
  zIndex: -1,
},
```

This matches how `components/ui/header.tsx` renders its `bottomBorder` with `zIndex: -1`.

## Common Mistakes

- **Dropdown hidden behind sibling sections**: Missing `zIndex` + `overflow: 'visible'` on ancestor Views between the dropdown and the Card.
- **Dropdown hidden behind borders/dividers**: Using `borderTopWidth` or `borderBottomWidth` on sibling Views. These paint above the dropdown in DOM order. Use absolutely-positioned Views with `zIndex: -1` instead.
- **Dropdown clipped**: The Card or a parent View has `overflow: 'hidden'` (default). Add `overflow: 'visible'` to the Card via style prop.
- **Transparent dropdown background**: Forgetting `backgroundColor` on the dropdown container or individual items.

## Reference Implementations

- Top bar actions dropdown: `components/ui/header.tsx`
- Row menu dropdowns: `components/pools/my-privacy-pools.tsx`, `components/portfolio/all-positions.tsx`
- Chain selector dropdown: `components/pools/my-privacy-pools.tsx` (header section)
