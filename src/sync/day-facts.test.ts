import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {ANONYMOUS_PAGE, ANONYMOUS_QUERY, buildDayFacts, keywordId} from "./day-facts";

describe("buildDayFacts", () => {
  it("stores detailed rows and puts the anonymized remainder into an (anonymous) row", () => {
    const {facts, keywords} = buildDayFacts({
      site: "sc-domain:example.com",
      date: "2026-09-01",
      totals: [{keys: ["usa", "MOBILE"], clicks: 10, impressions: 100, position: 5}],
      detailed: [
        {keys: ["shoes", "https://example.com/shoes", "usa", "MOBILE"], clicks: 6, impressions: 40, position: 3},
        {keys: ["boots", "https://example.com/boots", "usa", "MOBILE"], clicks: 1, impressions: 20, position: 8},
      ],
    });

    assert.equal(facts.length, 3);
    const anonymous = facts.find((fact) => fact.page === ANONYMOUS_PAGE);
    assert.ok(anonymous);
    assert.equal(anonymous.clicks, 3);
    assert.equal(anonymous.impressions, 40);
    // (5*100 - 3*40 - 8*20) / 40 = 5.5
    assert.equal(anonymous.position, 5.5);
    assert.equal(keywords.get(keywordId(ANONYMOUS_QUERY)), ANONYMOUS_QUERY);
    assert.equal(facts.reduce((sum, fact) => sum + fact.clicks, 0), 10);
  });

  it("skips the anonymous row when detailed rows cover the totals", () => {
    const {facts} = buildDayFacts({
      site: "https://example.com/",
      date: "2026-09-01",
      totals: [{keys: ["deu", "DESKTOP"], clicks: 2, impressions: 10, position: 4}],
      detailed: [{keys: ["q", "https://example.com/", "deu", "DESKTOP"], clicks: 2, impressions: 10, position: 4}],
    });
    assert.equal(facts.length, 1);
  });

  it("produces stable keyword ids that are safe JS integers", () => {
    assert.equal(keywordId("running shoes"), keywordId("running shoes"));
    assert.notEqual(keywordId("running shoes"), keywordId("running shoe"));
    assert.ok(Number.isSafeInteger(keywordId("running shoes")));
  });
});
