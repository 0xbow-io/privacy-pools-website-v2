export declare const MIN_CHROME_VERSION: string;
export declare function parseChromeVersion(version: string): number[];
export declare function isChromeOlderThan(version: string, min?: string): boolean;
export declare function assertPatchedChrome(version: string, min?: string): void;
