export function postWebhook(
  url: string | undefined,
  payload: unknown,
  opts?: {
    delaysMs?: number[];
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    log?: (msg: string) => void;
  },
): Promise<boolean>;
