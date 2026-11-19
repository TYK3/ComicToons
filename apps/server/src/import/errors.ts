/** Every IMPORT-1 failure the router returns as a clear message, never a stack trace. */
export type ImportErrorCode = 'bad-url' | 'not-found' | 'no-clips' | 'bad-chat-log' | 'not-configured';

const STATUS: Record<ImportErrorCode, number> = {
  'bad-url': 400,
  'not-found': 404,
  'no-clips': 404,
  'bad-chat-log': 400,
  'not-configured': 409,
};

export class ImportError extends Error {
  readonly status: number;
  constructor(readonly code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.status = STATUS[code];
  }
}
