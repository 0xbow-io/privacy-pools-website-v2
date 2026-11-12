import type { Browser } from 'playwright';

export declare const MIN_CHROME_VERSION: string;
/**
 * chromium.launch() on Google Chrome stable with the sandbox on. Any
 * executablePath, chromiumSandbox or sandbox-off arg passed in is ignored.
 */
export declare function launchChrome(options?: { headless?: boolean; args?: string[]; [key: string]: unknown }): Promise<Browser>;
