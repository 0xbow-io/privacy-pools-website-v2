/** Shared highlight movement for action tabs and page navigation. */
export const TAB_HIGHLIGHT_MOTION = {
  duration: 300,
  easing: (progress: number) => 1 - (1 - progress) ** 3,
  cssEasing: 'cubic-bezier(0.333333, 1, 0.666667, 1)',
};
