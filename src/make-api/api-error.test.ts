import { describe, expect, test } from "bun:test";
import { classifyApiResponse } from "./api-error";

describe("classifyApiResponse", () => {
  test.each([
    [401, { code: "AUTH_INVALID" }],
    [403, { code: "SCOPE_MISSING", providerCode: "SC403" }],
    [402, { code: "PLAN_RESTRICTED" }],
    [404, { code: "NOT_FOUND" }],
    [429, { code: "RATE_LIMITED", retryable: true }],
    [503, { code: "TRANSIENT", retryable: true }],
  ])("classifies status %i", async (status, expected) => {
    const response = new Response(
      JSON.stringify({ code: "SC403", message: "Permission denied" }),
      { status },
    );

    expect(await classifyApiResponse(response)).toMatchObject(expected);
  });

  test("classifies unsupported and invalid-data responses", async () => {
    const unsupported = await classifyApiResponse(new Response("Not supported", { status: 405 }));
    const invalidData = await classifyApiResponse(new Response("Invalid payload", { status: 422 }));

    expect(unsupported).toMatchObject({ code: "NOT_SUPPORTED", retryable: false });
    expect(invalidData).toMatchObject({ code: "INVALID_DATA", retryable: false });
  });

  test("includes Make detail and suberror messages behind a generic message", async () => {
    const result = await classifyApiResponse(Response.json({
      message: "Bad Request",
      code: "SC400",
      detail: "Validation failed for 1 parameter(s).",
      suberrors: [{ message: "Invalid blueprint: module not allowed", code: "IM007" }],
    }, { status: 400 }));
    expect(result).toMatchObject({ code: "INVALID_DATA", providerCode: "SC400" });
    expect(result.message).toBe(
      "Bad Request: Validation failed for 1 parameter(s). Invalid blueprint: module not allowed",
    );
  });

  test("keeps the response body available to its caller", async () => {
    const response = new Response(JSON.stringify({ message: "Permission denied" }), { status: 403 });

    await classifyApiResponse(response);

    expect(await response.json()).toEqual({ message: "Permission denied" });
  });

  test("redacts secrets from structured provider messages", async () => {
    const secretAuthorization = "Bearer authorization-secret";
    const secretToken = "token-secret";
    const secretApiKey = "api-key-secret";
    const secretCookie = "session-cookie-secret";
    const response = new Response(
      JSON.stringify({
        code: "SC403",
        message: {
          Authorization: secretAuthorization,
          Token: secretToken,
          apiKey: secretApiKey,
          cookie: secretCookie,
        },
      }),
      { status: 403 },
    );

    const error = await classifyApiResponse(response);

    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(secretAuthorization);
    expect(error.message).not.toContain(secretToken);
    expect(error.message).not.toContain(secretApiKey);
    expect(error.message).not.toContain(secretCookie);
  });

  test("redacts nested password and credential fields in structured messages and fallback payloads", async () => {
    const nestedPassword = "nested-password-secret";
    const nestedCredential = "nested-credential-secret";
    const fallbackPassword = "fallback-password-secret";
    const fallbackCredentials = "fallback-credentials-secret";
    const structured = await classifyApiResponse(new Response(JSON.stringify({
      message: {
        nested: {
          password: nestedPassword,
          credential: nestedCredential,
        },
      },
    }), { status: 400 }));
    const fallback = await classifyApiResponse(new Response(JSON.stringify({
      diagnostics: {
        Password: fallbackPassword,
        Credentials: fallbackCredentials,
      },
    }), { status: 400 }));

    expect(structured.message).toContain("[REDACTED]");
    expect(structured.message).not.toContain(nestedPassword);
    expect(structured.message).not.toContain(nestedCredential);
    expect(fallback.message).toContain("[REDACTED]");
    expect(fallback.message).not.toContain(fallbackPassword);
    expect(fallback.message).not.toContain(fallbackCredentials);
  });

  test("redacts bearer, token, api-key, and cookie values in text provider messages", async () => {
    const secrets = ["bearer-secret", "token-secret", "api-key-secret", "cookie-secret"];
    const response = new Response(
      `Authorization: Bearer ${secrets[0]}; Token ${secrets[1]}; apiKey=${secrets[2]}; Cookie: session=${secrets[3]}`,
      { status: 500 },
    );

    const error = await classifyApiResponse(response);

    expect(error.message).toContain("[REDACTED]");
    for (const secret of secrets) expect(error.message).not.toContain(secret);
  });

  test("redacts complete Authorization values for Basic and other schemes", async () => {
    const basicSecret = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
    const digestSecret = "digest-authorization-secret";
    const response = new Response(
      `Authorization: Basic ${basicSecret}; Authorization: Digest ${digestSecret}`,
      { status: 500 },
    );

    const error = await classifyApiResponse(response);

    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(basicSecret);
    expect(error.message).not.toContain(digestSecret);
  });

  test("fails closed for malformed assigned secret fields while preserving unrelated lines", async () => {
    const password = "malformed-password-secret";
    const passwordDirective = "password-following-directive";
    const credentials = "malformed-credentials-secret";
    const credentialDirective = "credentials-following-directive";
    const response = new Response([
      "Useful diagnostic line",
      `password=${password}, next=${passwordDirective}; mode=unsafe`,
      `Credentials: ${credentials}, next=${credentialDirective}; mode=unsafe`,
      "Another useful diagnostic line",
    ].join("\n"), { status: 500 });

    const error = await classifyApiResponse(response);

    expect(error.message).toContain("Useful diagnostic line");
    expect(error.message).toContain("Another useful diagnostic line");
    for (const secret of [password, passwordDirective, credentials, credentialDirective]) {
      expect(error.message).not.toContain(secret);
    }
  });

  test("fails closed for authorization and cookie header lines", async () => {
    const secrets = [
      "digest-nonce-secret",
      "digest-response-secret",
      "proxy-authorization-secret",
      "cookie-session-secret",
      "cookie-preference-secret",
      "set-cookie-session-secret",
      "set-cookie-token-secret",
    ];
    const response = new Response([
      "Useful diagnostic line",
      `Authorization: Digest username=\"alice\", nonce=\"${secrets[0]}\", response=\"${secrets[1]}\"`,
      `Proxy-Authorization: Custom ${secrets[2]}, next=still-sensitive`,
      `Cookie: session=${secrets[3]}; preference=${secrets[4]}`,
      `Set-Cookie: session=${secrets[5]}; HttpOnly; token=${secrets[6]}`,
      "Another useful diagnostic line",
    ].join("\n"), { status: 500 });

    const error = await classifyApiResponse(response);

    expect(error.message).toContain("Useful diagnostic line");
    expect(error.message).toContain("Another useful diagnostic line");
    for (const secret of secrets) expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("still-sensitive");
  });

  test("finds the first sensitive assignment anywhere in a text line", async () => {
    const secrets = [
      "x-api-key-secret",
      "prefixed-authorization-secret",
      "quoted-authorization-secret",
      "mixed-api-key-secret",
      "mixed-following-directive",
    ];
    const response = new Response([
      "Unaffected first line",
      `request failed X-API-Key: ${secrets[0]}; trace=still-sensitive`,
      `upstream error: Authorization: Basic ${secrets[1]}, next=still-sensitive`,
      `provider payload: \"authorization\": Basic ${secrets[2]}, next=still-sensitive`,
      `safe prefix then apiKey=${secrets[3]}, next=${secrets[4]}`,
      "Unaffected final line",
    ].join("\n"), { status: 500 });

    const error = await classifyApiResponse(response);

    expect(error.message).toContain("Unaffected first line");
    expect(error.message).toContain("Unaffected final line");
    expect(error.message).toContain("safe prefix then [REDACTED]");
    for (const secret of secrets) expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("still-sensitive");
  });

  test("fails closed for compound sensitive identifiers", async () => {
    const fields = [
      ["\"access_token\"", "access-token-secret"],
      ["refresh-token", "refresh-token-secret"],
      ["client_secret", "client-secret-secret"],
      ["api_key", "api-key-secret"],
      ["X_API_KEY", "x-api-key-secret"],
      ["tenant_authorization_token_backup", "long-compound-secret"],
    ] as const;
    const response = new Response([
      "Unaffected first line",
      ...fields.map(([field, secret]) => `provider detail: ${field} = ${secret}; next=still-sensitive`),
      "Unaffected final line",
    ].join("\n"), { status: 500 });

    const error = await classifyApiResponse(response);

    expect(error.message).toContain("Unaffected first line");
    expect(error.message).toContain("Unaffected final line");
    for (const [, secret] of fields) expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("still-sensitive");
  });

  test("bounds non-JSON provider messages at 2,000 characters", async () => {
    const response = new Response("x".repeat(2_100), { status: 500 });

    const error = await classifyApiResponse(response);

    expect(error.message).toHaveLength(2_000);
  });

  test("bounds provider codes independently of the response message", async () => {
    const providerCode = "C".repeat(2_100);
    const error = await classifyApiResponse(new Response(JSON.stringify({
      code: providerCode,
      message: "Provider request failed",
    }), { status: 500 }));

    expect(error.providerCode).toBe("C".repeat(2_000));
  });
});
