import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedSender, describeActions, inboundText, lastAiText, normalizePhone, parseDecision, plain, resumeFor, threadFor } from "./lib.ts";

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

test("parseDecision accepts only a whole-message YES or NO", () => {
  assert.equal(parseDecision("YES"), "approve");
  assert.equal(parseDecision(" yes! "), "approve");
  assert.equal(parseDecision("No."), "reject");
  assert.equal(parseDecision("ok, but change the wording first"), null);
  assert.equal(parseDecision("yes please"), null);
  assert.equal(parseDecision("no wait, approve it"), null);
  assert.equal(parseDecision("yesterday's building?"), null);
});

test("allowedSender is exact, E.164 and iMessage only", () => {
  const allowed = new Set(["+15551234567"]);
  assert.equal(allowedSender("+15551234567", "iMessage", allowed), true);
  assert.equal(allowedSender("+15551234567", undefined, allowed), true);
  assert.equal(allowedSender("+15551234567", "SMS", allowed), false);
  assert.equal(allowedSender("5551234567@outlook.com", "iMessage", allowed), false);
  assert.equal(allowedSender("+15551234568", "iMessage", allowed), false);
});

test("inboundText reads texts and swipe-replies, ignores tapbacks and receipts", () => {
  assert.equal(inboundText({ type: "text", text: " YES " }), "YES");
  assert.equal(inboundText({ type: "reply", content: { type: "text", text: "no" } }), "no");
  assert.equal(inboundText({ type: "reaction" }), null);
  assert.equal(inboundText({ type: "read" }), null);
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
  assert.match(text, /record a message to owner@example.com \(a draft in the app; nothing is sent to them\): "Hi"/);
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
  assert.equal(plain("**1,234 kW** on `TEST-A`\n## Verdict"), "1,234 kW on TEST-A\nVerdict");
});
