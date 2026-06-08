import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

const pkgPath = new URL("../package.json", import.meta.url);

test("package postinstall uses packaged install helpers", async () => {
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));

  assert.equal(pkg.scripts?.postinstall, "node ./scripts/postinstall.mjs");
  assert.match(pkg.scripts?.check, /scripts\/postinstall\.mjs/);
  assert.match(pkg.scripts?.check, /src\/binaries\.mjs/);
  assert.ok(
    pkg.dependencies?.["@ffmpeg-installer/ffmpeg"],
    "published install must include an npm-managed ffmpeg binary",
  );
  assert.ok(
    pkg.dependencies?.["@ffprobe-installer/ffprobe"],
    "published install must include an npm-managed ffprobe binary",
  );
  assert.ok(
    pkg.files.includes("scripts/postinstall.mjs"),
    "postinstall script must be included in npm packs",
  );
  assert.ok(
    pkg.files.includes("scripts/install-windows.ps1"),
    "Windows bootstrap script must be included in npm packs",
  );
});
