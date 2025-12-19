
export interface TranscriptionEntry {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export enum SessionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
