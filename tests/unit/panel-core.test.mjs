import "./_env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  averageRating,
  digestAnswers,
  panelRoundPrompt,
  parseMarker,
  parsePersonaList,
  resolveVote,
  tallyVotes
} from "../../ui/src/panel-core.mjs";

test("personas: JSON wrapped in prose or fences is parsed; duplicates and blanks are dropped; count is honoured", () => {
  const text = 'Sure! Here you go:\n```json\n[{"name":"Maya R.","persona":"28, commutes by train, listens to true crime."},' +
    '{"name":"maya r.","persona":"duplicate"},{"name":"","persona":"no name"},' +
    '{"name":"Dev P.","description":"41, audio engineer, hates over-compression."},{"name":"Ana L.","persona":"19, student."}]\n```';
  assert.deepEqual(parsePersonaList(text, 2), [
    { name: "Maya R.", persona: "28, commutes by train, listens to true crime." },
    { name: "Dev P.", persona: "41, audio engineer, hates over-compression." }
  ]);
});

test("personas: a plain 'Name — description' list is accepted when there is no JSON", () => {
  const text = "1. **Maya R.** — 28, commutes by train, loves true crime podcasts\n- Dev P.: 41, audio engineer who hates loud mixes";
  assert.deepEqual(parsePersonaList(text).map(p => p.name), ["Maya R.", "Dev P."]);
  assert.deepEqual(parsePersonaList("nothing useful"), []);
});

test("markers: the last VOTE/POSITION/RATING line wins, with markdown and spacing tolerated", () => {
  assert.equal(parseMarker("I like A.\nVOTE: A\nActually...\n**VOTE:** B", "VOTE"), "B");
  assert.equal(parseMarker("Good pacing.\nRATING = 7", "RATING"), "7");
  assert.equal(parseMarker("no marker", "VOTE"), null);
});

test("votes: letters, 'Option B', and option labels resolve; anything else is unclear", () => {
  const options = [{ label: "Calm intro", text: "a" }, { label: "Upbeat intro", text: "b" }];
  assert.equal(resolveVote("B", options), 1);
  assert.equal(resolveVote("option a", options), 0);
  assert.equal(resolveVote("the upbeat intro", options), 1);
  assert.equal(resolveVote("C", options), -1, "a letter beyond the options is not a vote");
  assert.equal(resolveVote("", options), -1);

  const tally = tallyVotes([
    { name: "Maya", text: "Prefer it.\nVOTE: B" },
    { name: "Dev", text: "VOTE: A" },
    { name: "Ana", text: "VOTE: Option B" },
    { name: "Raj", text: "Can't decide." }
  ], options);
  assert.deepEqual(tally.counts, [1, 2]);
  assert.deepEqual(tally.voters, [["Dev"], ["Maya", "Ana"]]);
  assert.deepEqual(tally.unclear, ["Raj"]);
  assert.equal(tally.total, 4);
});

test("ratings: only 0-10 numbers count toward the average", () => {
  assert.deepEqual(averageRating([{ text: "RATING: 8" }, { text: "RATING: 6/10" }, { text: "RATING: 42" }, { text: "none" }]), { average: 7, count: 2 });
  assert.equal(averageRating([{ text: "none" }]), null);
});

test("round prompts: round 1 is independent; later rounds carry the other panelists' answers", () => {
  const r1 = panelRoundPrompt({ mode: "vote", topic: "Which intro?", options: [{ label: "", text: "calm" }, { label: "", text: "loud" }], round: 1, rounds: 2 });
  assert.match(r1, /Option A:\ncalm/);
  assert.match(r1, /VOTE: <option letter>/);
  assert.doesNotMatch(r1, /other panelists said/);
  const r2 = panelRoundPrompt({ mode: "debate", topic: "Tabs or spaces?", round: 2, rounds: 2, othersDigest: "- Dev: tabs" });
  assert.match(r2, /round 2 of 2[\s\S]*- Dev: tabs/);
  assert.match(r2, /POSITION:/);
});

test("digest: a panelist does not see their own answer, and a large panel stays within the budget", () => {
  const answers = Array.from({ length: 80 }, (_, i) => ({ name: `P${i}`, text: "x".repeat(1000) }));
  const digest = digestAnswers(answers, { excludeName: "P0", budgetChars: 5000 });
  assert.ok(!digest.includes("- P0:"));
  assert.ok(digest.length < 5200, `digest length ${digest.length}`);
  assert.match(digest, /more panelists\)$/);
});
