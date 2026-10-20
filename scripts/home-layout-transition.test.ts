import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise layout changes without loading the native renderer.
const source = readFileSync('components/home/layout-transition.tsx', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

function fixture(reducedMotion = false, positionGroup?: string) {
  const animations: { frames: Keyframe[]; cancelled: boolean }[] = [];
  let box = { left: 800, top: 250, width: 480, height: 450 };
  const element = {
    getBoundingClientRect: () => ({ ...box }),
    animate: (frames: Keyframe[]) => {
      const animation = {
        frames,
        cancelled: false,
        cancel() {
          this.cancelled = true;
        },
      };
      animations.push(animation);
      return animation;
    },
  };
  class Component {
    constructor(public props: { layoutKey: string }) {}
  }
  const exports = {} as {
    LayoutTransition: typeof import('../components/home/layout-transition').LayoutTransition;
  };
  const require = (name: string) => {
    if (name === 'react') return { Component, createRef: () => ({ current: element }) };
    if (name === 'react-native') return { Platform: { OS: 'web' } };
    if (name === 'react/jsx-runtime') return {};
    throw new Error(`Unexpected dependency ${name}`);
  };
  new Function('exports', 'require', 'window', compiled)(exports, require, {
    matchMedia: () => ({ matches: reducedMotion }),
  });
  const instance = new exports.LayoutTransition({ layoutKey: 'resting', positionGroup, children: null });
  const move = (key: string, next: typeof box) => {
    const previous = instance.props;
    Object.assign(instance, { props: { layoutKey: key, positionGroup, children: null } });
    const before = instance.getSnapshotBeforeUpdate(previous);
    box = next;
    instance.componentDidUpdate(previous, {}, before);
  };
  return { animations, instance, move };
}

describe('home layout transition', () => {
  test('does not animate unrelated rerenders', () => {
    const { animations, move } = fixture();
    move('resting', { left: 800, top: 250, width: 480, height: 450 });
    expect(animations).toHaveLength(0);
  });

  test('landing and session changes fade without travelling across the hero', () => {
    const { animations, move } = fixture(false);
    move('connected', { left: 480, top: 100, width: 480, height: 650 });
    expect(animations[0].frames).toEqual([{ opacity: 0.85 }, { opacity: 1 }]);
  });

  test('panel layout changes move without scaling controls', () => {
    const { animations, move } = fixture(false, 'account');
    move('panel', { left: 920, top: 100, width: 480, height: 450 });
    expect(animations[0].frames).toEqual([{ transform: 'translate(-120px, 150px)' }, { transform: 'none' }]);
  });

  test('reduced motion settles without animation', () => {
    const { animations, move } = fixture(true);
    move('connected', { left: 480, top: 100, width: 480, height: 650 });
    expect(animations).toHaveLength(0);
  });

  test('interruptions replace the old animation and unmount cancels it', () => {
    const { animations, move, instance } = fixture();
    move('panel', { left: 920, top: 100, width: 440, height: 450 });
    move('resting', { left: 800, top: 250, width: 480, height: 450 });
    expect(animations[0].cancelled).toBe(true);
    instance.componentWillUnmount();
    expect(animations[1].cancelled).toBe(true);
  });
});
