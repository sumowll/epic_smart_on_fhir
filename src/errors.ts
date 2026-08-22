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
