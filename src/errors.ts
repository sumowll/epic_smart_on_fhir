export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly publicMessage: string,
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = "AppError";
  }
}

export class UpstreamError extends AppError {
  public constructor(
    code: string,
    publicMessage: string,
    public readonly upstreamStatus?: number,
    options?: ErrorOptions,
  ) {
    super(502, code, publicMessage, options);
    this.name = "UpstreamError";
  }
}

export class ReconnectRequiredError extends AppError {
  public constructor(message = "Your MyChart authorization has expired or was revoked. Please connect again.") {
    super(401, "reconnect_required", message);
    this.name = "ReconnectRequiredError";
  }
}

export interface SafeErrorDiagnostic {
  readonly causeCode?: string;
  readonly upstreamStatus?: number;
}

export function safeErrorDiagnostic(error: unknown): SafeErrorDiagnostic {
  let current: unknown = error;
  let causeCode: string | undefined;
  let upstreamStatus: number | undefined;
  const visited = new Set<unknown>();

  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    if (depth > 0 && causeCode === undefined && current instanceof AppError) {
      causeCode = current.code;
    }
    if (
      upstreamStatus === undefined &&
      current instanceof UpstreamError &&
      current.upstreamStatus !== undefined
    ) {
      upstreamStatus = current.upstreamStatus;
    }
    current = current.cause;
  }

  return {
    ...(causeCode ? { causeCode } : {}),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
  };
}
