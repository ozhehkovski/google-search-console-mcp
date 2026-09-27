import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {isAuthorized} from "./server";
import {parseServiceAccountKey} from "../google/auth";

describe("isAuthorized", () => {
  it("allows everything when no token is configured", () => {
    assert.equal(isAuthorized(undefined, ""), true);
  });

  it("requires the exact bearer token", () => {
    assert.equal(isAuthorized("Bearer secret-token", "secret-token"), true);
    assert.equal(isAuthorized("bearer secret-token", "secret-token"), true);
    assert.equal(isAuthorized("Bearer secret-tokem", "secret-token"), false);
    assert.equal(isAuthorized("secret-token", "secret-token"), false);
    assert.equal(isAuthorized(undefined, "secret-token"), false);
  });
});

describe("parseServiceAccountKey", () => {
  const valid = {type: "service_account", project_id: "p", client_email: "gsc@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\n"};

  it("accepts a service account key", () => {
    assert.equal(parseServiceAccountKey(JSON.stringify(valid)).client_email, valid.client_email);
  });

  it("rejects OAuth client files and malformed JSON with a helpful message", () => {
    assert.throws(() => parseServiceAccountKey(JSON.stringify({installed: {client_id: "x"}})), /OAuth client/);
    assert.throws(() => parseServiceAccountKey("{"), /not valid JSON/);
    assert.throws(() => parseServiceAccountKey(JSON.stringify({type: "authorized_user"})), /service account/);
  });
});

describe("toGscApiError", () => {
  it("maps rejected service account keys to unauthorized", async () => {
    const {toGscApiError} = await import("../google/errors");
    const error = toGscApiError({response: {status: 400, data: {error: "invalid_grant"}}}, "sites.list");
    assert.equal(error.code, "unauthorized");
    assert.equal(toGscApiError({response: {status: 403, data: {error: {message: "User does not have sufficient permission"}}}}, "x").code, "insufficient_permission");
    assert.equal(toGscApiError({response: {status: 429}}, "x").code, "quota_exceeded");
  });
});
