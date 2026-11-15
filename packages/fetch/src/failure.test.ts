import type { Answer, Outcome } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import { failureOf, MAX_DETAIL, problemDetail } from "./failure.ts";

const answer = (status: number, statusText: string, outcome: Outcome, retryAfterMs?: number, body = ""): Answer => ({
  reply: { status, statusText, headers: {}, body },
  classified: { outcome, retryAfterMs, note: undefined },
});

describe("failureOf", () => {
  it.each([
    [answer(429, "Too Many Requests", "rate-limited", 30_000), { kind: "rate-limited", message: "429 Too Many Requests", retryAfter: 30_000 }],
    [answer(429, "Too Many Requests", "rate-limited"), { kind: "rate-limited", message: "429 Too Many Requests" }],
    [answer(503, "Service Unavailable", "unavailable", 5000), { kind: "server", message: "503 Service Unavailable", retryAfter: 5000 }],
    [answer(500, "Internal Server Error", "error"), { kind: "server", message: "500 Internal Server Error" }],
    [answer(401, "Unauthorized", "blocked"), { kind: "auth", message: "401 Unauthorized" }],
    [answer(403, "Forbidden", "blocked"), { kind: "refused", message: "403 Forbidden" }],
    [answer(400, "Bad Request", "error"), { kind: "refused", message: "400 Bad Request" }],
    [answer(404, "Not Found", "not-found"), { kind: "refused", message: "404 Not Found (not-found)" }],
    [answer(304, "Not Modified", "not-modified"), { kind: "refused", message: "304 Not Modified (not-modified)" }],
    [answer(200, "OK", "challenge"), { kind: "refused", message: "200 OK (challenge)" }],
  ])("maps %j", (given, failure) => {
    expect(failureOf(given)).toEqual(failure);
  });

  it("gives the status code alone when the status text is empty", () => {
    expect(failureOf(answer(502, "", "unavailable"))).toEqual({ kind: "server", message: "502" });
  });

  it("adds the problem text that the reader finds", () => {
    const body = JSON.stringify({ title: "Bad Request", detail: 'Parameter "area" is invalid' });
    expect(failureOf(answer(400, "Error", "error", undefined, body), problemDetail)).toEqual({ kind: "refused", message: '400 Error: Parameter "area" is invalid' });
    expect(failureOf(answer(400, "Error", "error", undefined, "<html>no</html>"), problemDetail)).toEqual({ kind: "refused", message: "400 Error" });
  });

  it("removes the control characters of the problem text, and cuts a long text", () => {
    const evil = failureOf(answer(400, "Error", "error"), () => "line one\nline two\u0007");
    expect(evil).toEqual({ kind: "refused", message: "400 Error: line one line two" });
    const long = failureOf(answer(400, "Error", "error"), () => "x".repeat(MAX_DETAIL * 2));
    expect(long.message).toBe(`400 Error: ${"x".repeat(MAX_DETAIL)}`);
    expect(failureOf(answer(400, "Error", "error"), () => " \n ")).toEqual({ kind: "refused", message: "400 Error" });
  });

  it("gives the status line when the reader throws", () => {
    const throws = (): string => {
      throw new Error("no");
    };
    expect(failureOf(answer(500, "Internal Server Error", "error"), throws)).toEqual({ kind: "server", message: "500 Internal Server Error" });
  });
});

describe("problemDetail", () => {
  it("reads the text detail of a problem document", () => {
    expect(problemDetail(JSON.stringify({ type: "about:blank", detail: "the detail" }))).toBe("the detail");
  });

  it.each(["", "{", "[]", "null", '"text"', JSON.stringify({ title: "no detail" }), JSON.stringify({ detail: 42 })])("gives no text for %j", (body) => {
    expect(problemDetail(body)).toBeUndefined();
  });
});
