import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {displayName, normalizeSiteRef} from "../google/property";

describe("site references", () => {
  it("normalizes what users type to match Search Console properties", () => {
    assert.equal(normalizeSiteRef("sc-domain:Example.com"), "example.com");
    assert.equal(normalizeSiteRef("https://www.example.com/"), "example.com");
    assert.equal(normalizeSiteRef(" www.example.com "), "example.com");
    assert.equal(normalizeSiteRef("https://example.com/blog/"), "example.com/blog");
  });

  it("formats property names for people", () => {
    assert.equal(displayName("sc-domain:example.com"), "example.com");
    assert.equal(displayName("https://example.com/"), "example.com");
    assert.equal(displayName("https://example.com/blog/"), "example.com/blog");
  });
});
