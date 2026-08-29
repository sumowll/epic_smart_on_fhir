import { describe, expect, it } from "vitest";

import {
  AppError,
  UpstreamError,
  safeErrorDiagnostic,
} from "../src/errors.js";

describe("safe error diagnostics", () => {
  it("reports bounded error codes and upstream status without messages", () => {
    const upstream = new UpstreamError(
      "code_exchange_failed",
      "message that must not be audited",
      401,
    );
    const wrapped = new AppError(
      502,
      "authorization_cleanup_required",
      "public cleanup message",
      { cause: upstream },
    );

    expect(safeErrorDiagnostic(wrapped)).toEqual({
      causeCode: "code_exchange_failed",
      upstreamStatus: 401,
    });
    expect(JSON.stringify(safeErrorDiagnostic(wrapped))).not.toContain("message that must not be audited");
  });

  it("does not expose raw error causes", () => {
    expect(safeErrorDiagnostic(new Error("token-shaped secret"))).toEqual({});
  });
});
