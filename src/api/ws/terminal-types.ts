export type TerminalMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type TerminalPush =
  | { type: 'output'; data: string }
  | { type: 'pong' }
  | { type: 'error'; message: string }
  | { type: 'runtime'; status: string; pid?: number };
