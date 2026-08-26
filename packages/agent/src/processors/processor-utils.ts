export interface ProcessorRequestContextLike {
  get?: (key: string) => unknown;
}

export function getProcessorParentSignal(args: {
  abortSignal?: AbortSignal;
  requestContext?: ProcessorRequestContextLike;
}): AbortSignal | undefined {
  if (args.abortSignal) return args.abortSignal;
  const signal = args.requestContext?.get?.('abortSignal');
  return signal instanceof AbortSignal ? signal : undefined;
}

export interface BoundedProcessorExecutionOptions<T> {
  parentSignal?: AbortSignal;
  timeoutMs: number;
  timeoutMessage: string;
  parentAbortMessage: string;
  execute: (signal: AbortSignal) => Promise<T> | T;
}

export async function runBoundedProcessorExecution<T>(
  options: BoundedProcessorExecutionOptions<T>
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const combinedSignal = options.parentSignal
    ? AbortSignal.any([options.parentSignal, timeoutSignal])
    : timeoutSignal;

  const abortMessage = (): string =>
    options.parentSignal?.aborted ? options.parentAbortMessage : options.timeoutMessage;

  if (combinedSignal.aborted) {
    throw new Error(abortMessage());
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      combinedSignal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(abortMessage()));
    };

    combinedSignal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => options.execute(combinedSignal))
      .then(
        result => {
          if (settled) return;
          settled = true;
          cleanup();
          if (combinedSignal.aborted) {
            reject(new Error(abortMessage()));
          } else {
            resolve(result);
          }
        },
        error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
        }
      );
  });
}
