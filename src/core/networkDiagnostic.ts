// SPDX-License-Identifier: GPL-3.0-or-later
// Static classifications only: exception messages, URLs and response bodies never leave this helper.
const reasons = new Set(["dns_failure", "connection_reset", "connection_refused", "connection_closed",
    "tls_error", "host_timeout", "host_aborted", "host_network_error", "unknown_failure"]);
export function networkFailureReason(error: unknown): string {
    try {
        if (!error || typeof error !== "object") return "unknown_failure";
        const e = error as { networkFailureReason?: unknown; code?: unknown; name?: unknown; cause?: unknown };
        if (typeof e.networkFailureReason === "string" && reasons.has(e.networkFailureReason)) return e.networkFailureReason;
        const code = typeof e.code === "string" ? e.code : "";
        if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns_failure";
        if (code === "ECONNRESET") return "connection_reset";
        if (code === "ECONNREFUSED") return "connection_refused";
        if (["EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET"].includes(code)) return "connection_closed";
        if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return "host_timeout";
        if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) return "tls_error";
        if (e.name === "AbortError") return "host_aborted";
        if (e.name === "NetworkError") return "host_network_error";
        // Node fetch commonly puts the structured socket error in cause. One level
        // only, with a fresh object, avoids cycles and arbitrary nested data.
        if (e.cause && typeof e.cause === "object") {
            const c = e.cause as { code?: unknown; name?: unknown };
            return networkFailureReason({ code: c.code, name: c.name });
        }
    } catch { /* Host exception getters must not break transport error handling. */ }
    return "unknown_failure";
}
