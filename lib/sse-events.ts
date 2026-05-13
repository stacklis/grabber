export type StatusEvent = {
  type: "status";
  message: string;
  tool?: string;
  filename?: string;
  path?: string;
};

export type ProgressEvent = {
  type: "progress";
  percent?: number;
  size?: string;
  speed?: string;
  eta?: string;
  filename: string;
  indeterminate?: boolean;
  path?: string;
  count?: number;
};

export type DoneEvent = {
  type: "done";
  message: string;
  filename: string;
  outputFolder: string;
  count: number;
};

export type ErrorEvent = {
  type: "error";
  message: string;
};

export type DownloadEvent = StatusEvent | ProgressEvent | DoneEvent | ErrorEvent;
