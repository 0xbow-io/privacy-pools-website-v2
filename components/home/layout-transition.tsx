import { Component, createRef, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

/* ANIMATION STORYBOARD
 *   0ms  capture the current visual position before the layout changes
 * 260ms  settle panel layout changes without scaling text or controls
 * 160ms  content-only changes soften in place
 * Resizing, session changes and reduced motion never travel across the page.
 */
const LAYOUT_MOTION = { duration: 160, easing: 'cubic-bezier(0.32, 0, 0.2, 1)' };
const POSITION_MOTION = { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
type Props = { positionGroup?: string; layoutKey: string; viewportWidth?: number; className?: string; testID?: string; children: ReactNode };

export class LayoutTransition extends Component<Props> {
  private node = createRef<View>();
  private animation: Animation | undefined;

  private element() {
    return Platform.OS === 'web' ? (this.node.current as unknown as HTMLElement | null) : null;
  }

  private soften() {
    const element = this.element();
    this.animation?.cancel();
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !element.animate) return;
    const after = element.getBoundingClientRect();
    if (!after.width || !after.height) return;
    this.animation = element.animate([{ opacity: 0.85 }, { opacity: 1 }], LAYOUT_MOTION);
  }

  componentDidMount() {
    this.soften();
  }

  getSnapshotBeforeUpdate(previous: Props) {
    if (!this.props.positionGroup || previous.positionGroup !== this.props.positionGroup
      || previous.viewportWidth !== this.props.viewportWidth
      || previous.layoutKey === this.props.layoutKey) return null;
    // Includes an interrupted animation's current transform, so a second
    // click continues from what the user sees instead of the prior target.
    const rect = this.element()?.getBoundingClientRect();
    return rect?.width && rect.height ? rect : null;
  }

  componentDidUpdate(previous: Props, _state: unknown, before: DOMRect | null) {
    if (previous.layoutKey === this.props.layoutKey && previous.viewportWidth === this.props.viewportWidth) return;
    this.animation?.cancel();
    if (previous.viewportWidth !== this.props.viewportWidth) return;
    const element = this.element();
    if (before && element?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const after = element.getBoundingClientRect();
      if (!after.width || !after.height) return;
      this.animation = element.animate([
        { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` },
        { transform: 'none' },
      ], POSITION_MOTION);
    } else {
      this.soften();
    }
  }

  componentWillUnmount() {
    this.animation?.cancel();
  }

  render() {
    return (
      <View ref={this.node} testID={this.props.testID} className={this.props.className}>
        {this.props.children}
      </View>
    );
  }
}
