import { createHash } from "node:crypto";

// 20 adjectives x 20 nouns x 1000 digits = 400,000 possible aliases.
// Aliases are deterministic from the run directory name (sha256-seeded),
// so the same directory always resolves to the same alias.

export const ALIAS_ADJECTIVES = [
  "brave",
  "breezy",
  "cheeky",
  "chipper",
  "cozy",
  "dapper",
  "eager",
  "fuzzy",
  "gentle",
  "jolly",
  "lucky",
  "nimble",
  "plucky",
  "quick",
  "snappy",
  "spry",
  "sunny",
  "swift",
  "witty",
  "zesty",
];

export const ALIAS_NOUNS = [
  "badger",
  "comet",
  "dolphin",
  "eagle",
  "falcon",
  "gecko",
  "heron",
  "iris",
  "jaguar",
  "koala",
  "lynx",
  "marlin",
  "narwhal",
  "otter",
  "panda",
  "quokka",
  "raven",
  "sparrow",
  "tiger",
  "walrus",
];

export const ALIAS_PATTERN = /^[a-z]+-[a-z]+-\d{3}$/;

export function aliasFor(runDirName) {
  if (typeof runDirName !== "string" || runDirName.length === 0) {
    throw new TypeError("aliasFor requires a non-empty string");
  }
  const hash = createHash("sha256").update(runDirName).digest();
  const adj = ALIAS_ADJECTIVES[hash.readUInt32BE(0) % ALIAS_ADJECTIVES.length];
  const noun = ALIAS_NOUNS[hash.readUInt32BE(4) % ALIAS_NOUNS.length];
  const digits = String(hash.readUInt32BE(8) % 1000).padStart(3, "0");
  return `${adj}-${noun}-${digits}`;
}

export function isAlias(input) {
  return typeof input === "string" && ALIAS_PATTERN.test(input);
}
