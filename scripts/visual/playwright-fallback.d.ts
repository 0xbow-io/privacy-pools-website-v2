// Fallback ambient types for 'playwright' so `tsc --noEmit` stays green when
// the TEMPORARY playwright dev-dependency is not installed (harness sessions
// add it with `safewrap bun add --exact playwright@1.61.1` and revert
// package.json/bun.lock before committing — see README.md).
//
// NOTE: an ambient `declare module` wins even when the real package IS
// installed, so this is NOT merely an unresolved-import fallback — it is the
// type surface the harness compiles against either way. A harness script that
// calls a real Playwright API missing from here fails `tsc --noEmit` with a
// confusing "does not exist on type 'Page'". Add the method here when that
// happens; keep it to the subset the harness actually uses.
declare module 'playwright' {
  export interface Locator {
    first(): Locator;
    last(): Locator;
    count(): Promise<number>;
    click(options?: { timeout?: number; force?: boolean; position?: { x: number; y: number } }): Promise<void>;
    fill(value: string, options?: { timeout?: number }): Promise<void>;
    waitFor(options?: { timeout?: number; state?: string }): Promise<void>;
    boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
    isVisible(options?: { timeout?: number }): Promise<boolean>;
  }
  export interface Keyboard {
    press(key: string): Promise<void>;
  }
  export interface Mouse {
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
    click(x: number, y: number): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  }
  export interface Touchscreen {
    tap(x: number, y: number): Promise<void>;
  }
  export interface Page {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    evaluate<R, A = unknown>(fn: ((arg: A) => R) | (() => R), arg?: A): Promise<R>;
    waitForFunction<A = unknown>(
      fn: ((arg: A) => unknown) | string,
      arg?: A,
      options?: { timeout?: number },
    ): Promise<unknown>;
    waitForTimeout(ms: number): Promise<void>;
    screenshot(options?: {
      type?: 'png' | 'jpeg';
      path?: string;
      animations?: 'disabled' | 'allow';
      caret?: 'hide' | 'initial';
      fullPage?: boolean;
      timeout?: number;
      clip?: { x: number; y: number; width: number; height: number };
    }): Promise<Buffer>;
    getByText(text: string, options?: { exact?: boolean }): Locator;
    getByTestId(testId: string): Locator;
    getByPlaceholder(text: string, options?: { exact?: boolean }): Locator;
    exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
    addInitScript(script: string | ((arg: never) => unknown), arg?: unknown): Promise<void>;
    keyboard: Keyboard;
    mouse: Mouse;
    touchscreen: Touchscreen;
    goBack(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    viewportSize(): { width: number; height: number } | null;
    setViewportSize(size: { width: number; height: number }): Promise<void>;
    on(event: string, handler: (payload: { message: string }) => void): void;
    url(): string;
    close(): Promise<void>;
  }
  export interface APIResponse {
    status(): number;
    headers(): Record<string, string>;
    body(): Promise<Buffer>;
  }
  export interface Request {
    url(): string;
    method(): string;
    postData(): string | null;
    headers(): Record<string, string>;
  }
  export interface Route {
    request(): Request;
    fetch(): Promise<APIResponse>;
    fulfill(options: {
      status?: number;
      contentType?: string;
      body?: Buffer | string;
      response?: APIResponse;
    }): Promise<void>;
    abort(errorCode?: string): Promise<void>;
    fallback(): Promise<void>;
  }
  export interface BrowserContext {
    route(url: string | RegExp | ((url: URL) => boolean), handler: (route: Route) => Promise<void> | void): Promise<void>;
    addInitScript(script: string | ((arg: never) => unknown), arg?: unknown): Promise<void>;
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  export interface Browser {
    newContext(options?: {
      viewport?: { width: number; height: number };
      deviceScaleFactor?: number;
      locale?: string;
      timezoneId?: string;
      colorScheme?: 'light' | 'dark';
      reducedMotion?: 'reduce' | 'no-preference';
      hasTouch?: boolean;
      isMobile?: boolean;
    }): Promise<BrowserContext>;
    newPage(options?: { viewport?: { width: number; height: number } }): Promise<Page>;
    close(): Promise<void>;
  }
  export const chromium: {
    launch(options?: { headless?: boolean; executablePath?: string; args?: string[] }): Promise<Browser>;
  };
}
