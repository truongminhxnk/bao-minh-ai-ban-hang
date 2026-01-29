
export interface AudioConfig {
  sampleRate: number;
  numChannels: number;
}

export enum SessionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface Transcription {
  text: string;
  isUser: boolean;
  timestamp: number;
}
