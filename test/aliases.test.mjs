import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALIAS_ADJECTIVES,
  ALIAS_NOUNS,
  ALIAS_PATTERN,
  aliasFor,
  isAlias,
} from "../src/aliases.mjs";

test("word lists are 20 each and lowercase", () => {
  assert.equal(ALIAS_ADJECTIVES.length, 20);
  assert.equal(ALIAS_NOUNS.length, 20);
  for (const word of [...ALIAS_ADJECTIVES, ...ALIAS_NOUNS]) {
    assert.match(word, /^[a-z]+$/);
  }
});

test("aliasFor produces verb-noun-NNN matching the alias pattern", () => {
  const alias = aliasFor("localhost-3000-20260518-181109");
  assert.match(alias, ALIAS_PATTERN);
  const [verb, noun, digits] = alias.split("-");
  assert.ok(ALIAS_ADJECTIVES.includes(verb));
  assert.ok(ALIAS_NOUNS.includes(noun));
  assert.equal(digits.length, 3);
});

test("aliasFor is deterministic for the same input", () => {
  const a = aliasFor("localhost-3000-20260518-181109");
  const b = aliasFor("localhost-3000-20260518-181109");
  assert.equal(a, b);
});

test("aliasFor produces different aliases for different inputs", () => {
  const a = aliasFor("localhost-3000-20260518-181109");
  const b = aliasFor("localhost-3000-20260518-181110");
  assert.notEqual(a, b);
});

test("aliasFor throws on empty input", () => {
  assert.throws(() => aliasFor(""), /non-empty string/);
  assert.throws(() => aliasFor(null), /non-empty string/);
});

test("isAlias accepts alias-shaped strings and rejects others", () => {
  assert.equal(isAlias("cheeky-monkey-427"), true);
  assert.equal(isAlias("brave-falcon-001"), true);
  assert.equal(isAlias("cheeky-monkey-42"), false); // only two digits
  assert.equal(isAlias("cheeky-monkey-4271"), false); // four digits
  assert.equal(isAlias("Cheeky-Monkey-427"), false); // uppercase
  assert.equal(isAlias("./timelapse-runs/foo"), false);
  assert.equal(isAlias("localhost-3000-20260518-181109"), false);
  assert.equal(isAlias(""), false);
  assert.equal(isAlias(undefined), false);
});
