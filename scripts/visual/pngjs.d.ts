// Minimal ambient types for pngjs (present transitively via qrcode → pngjs@5;
// it ships no types and the repo pins exact deps, so we type only what the
// harness uses).
declare module 'pngjs' {
  export class PNG {
    constructor(options?: { width?: number; height?: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
}
