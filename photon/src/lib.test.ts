import assert from "node:assert/strict";
import { test } from "node:test";
import { describeActions, lastAiText, normalizePhone, parseDecision, plain, resumeFor, threadFor } from "./lib.ts";

test("normalizePhone accepts the formats people type", () => {
  assert.equal(normalizePhone("5551234567"), "+15551234567");
  assert.equal(normalizePhone("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("+15551234567"), "+15551234567");
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone("someone@example.com"), "");
});

test("threadFor is a stable UUID per sender", () => {
  const a = threadFor("+15551234567");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, threadFor("+15551234567"));
  assert.notEqual(a, threadFor("+15551234568"));
});

test("parseDecision reads YES/NO and nothing else", () => {
  assert.equal(parseDecision("YES"), "approve");
  assert.equal(parseDecision(" yes please "), "approve");
  assert.equal(parseDecision("ok"), "approve");
  assert.equal(parseDecision("No"), "reject");
  assert.equal(parseDecision("cancel that"), "reject");
  assert.equal(parseDecision("yesterday's building?"), null);
  assert.equal(parseDecision("is 235279 worth it?"), null);
  assert.equal(parseDecision("nothing"), null);
});

test("resumeFor sends one decision per action request", () => {
  const one = [{ id: "i1", actions: [{ name: "send_outreach" }, { name: "watch_building" }] }];
  assert.deepEqual(resumeFor(one, "approve"), { decisions: [{ type: "approve" }, { type: "approve" }] });
  const two = [{ id: "a", actions: [{ name: "send_outreach" }] }, { id: "b", actions: [{ name: "watch_building" }] }];
  assert.deepEqual(resumeFor(two, "reject"), { a: { decisions: [{ type: "reject" }] }, b: { decisions: [{ type: "reject" }] } });
});

test("describeActions names what will happen", () => {
  const text = describeActions([
    { name: "send_outreach", args: { to: "owner@example.com", text: "Hi" } },
    { name: "watch_building", args: { property_id: "TEST-A", reason: "re-roof soon" } },
  ]);
  assert.match(text, /send owner@example.com this message: "Hi"/);
  assert.match(text, /start watching building TEST-A \(re-roof soon\)/);
});

test("lastAiText takes only this run's final answer", () => {
  const values = {
    messages: [
      { type: "human", content: "q1" },
      { type: "ai", content: "old answer" },
      { type: "human", content: "q2" },
      { type: "ai", content: [{ type: "text", text: "new " }, { type: "text", text: "answer" }] },
      { type: "ai", content: "" },
    ],
  };
  assert.equal(lastAiText(values, 2), "new answer");
  assert.equal(lastAiText(values, 4), null);
  assert.equal(lastAiText({}, 0), null);
});

test("plain drops markdown iMessage would show literally", () => {
  assert.equal(plain("**2,775 kW** on `235279`\n## Verdict"), "2,775 kW on 235279\nVerdict");
});
