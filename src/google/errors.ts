export type GscApiErrorCode =
    | "unauthorized"          // 401: invalid credentials
    | "insufficient_scope"    // 403: missing OAuth scope
    | "insufficient_permission" // 403: no access to the property
    | "not_found"             // 404
    | "quota_exceeded"        // 429 or quota/rateLimitExceeded
    | "invalid_argument"      // 400
    | "server_error"          // 5xx
    | "unknown";

export class GscApiError extends Error {
    constructor(
        public readonly code: GscApiErrorCode,
        public readonly status: number | null,
        message: string,
        options?: {cause?: unknown},
    ) {
        super(message);
        this.name = "GscApiError";
        if (options?.cause !== undefined) {
            (this as {cause?: unknown}).cause = options.cause;
        }
    }

    get retryable(): boolean {
        return this.code === "quota_exceeded" || this.code === "server_error";
    }
}

type GaxiosLikeError = {
    status?: number;
    code?: number | string;
    message?: string;
    response?: {
        status?: number;
        data?: {
            error?: {
                code?: number;
                message?: string;
                status?: string;
                errors?: Array<{reason?: string}>;
                details?: Array<{reason?: string}>;
            } | string;
        };
    };
};

/** Converts a googleapis (gaxios) error into a GscApiError */
export function toGscApiError(error: unknown, operation: string): GscApiError {
    if (error instanceof GscApiError) return error;

    const err = (error ?? {}) as GaxiosLikeError;
    const status = err.response?.status ?? err.status ?? (typeof err.code === "number" ? err.code : null);
    const data = err.response?.data?.error;
    const apiMessage = typeof data === "string" ? data : data?.message;
    const message = `${operation} failed${status ? ` (${status})` : ""}: ${apiMessage ?? err.message ?? "unknown error"}`;
    const reasons = typeof data === "object" && data
        ? [...(data.errors ?? []), ...(data.details ?? [])].map((e) => e.reason ?? "").concat(data.status ?? "")
        : [];
    const text = `${reasons.join(" ")} ${apiMessage ?? ""}`.toLowerCase();

    let code: GscApiErrorCode = "unknown";
    // OAuth token endpoint errors: deleted/disabled service account, revoked or malformed key
    if (status === 401 || /invalid_grant|unauthorized_client|invalid_client/.test(text)) {
        code = "unauthorized";
    } else if (status === 429 || /quota|ratelimit|rate_limit|resource_exhausted/.test(text)) {
        code = "quota_exceeded";
    } else if (status === 403) {
        code = /scope/.test(text) ? "insufficient_scope" : "insufficient_permission";
    } else if (status === 404) {
        code = "not_found";
    } else if (status === 400) {
        code = "invalid_argument";
    } else if (status !== null && status >= 500) {
        code = "server_error";
    }

    return new GscApiError(code, status, message, {cause: error});
}
