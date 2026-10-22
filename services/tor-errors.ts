/** Thrown when Tor cannot be used, so the caller fails rather than leaks. */
export class TorUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TorUnavailableError';
  }
}
