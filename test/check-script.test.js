const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

test('package.json has ci script that chains check and test', () => {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.strictEqual(
    pkg.scripts.ci,
    'npm run check && npm test',
    'scripts.ci must be exactly "npm run check && npm test"'
  );
});

test('CI workflow file exists and has required structure', () => {
  const workflowPath = resolve(__dirname, '../.github/workflows/test.yml');
  assert.ok(existsSync(workflowPath), '.github/workflows/test.yml must exist');

  const workflowContent = readFileSync(workflowPath, 'utf8');
  assert.ok(
    workflowContent.includes('pull_request'),
    'workflow must have pull_request trigger'
  );
  assert.ok(
    workflowContent.includes('push'),
    'workflow must have push trigger'
  );
  assert.ok(
    workflowContent.includes('npm run ci') || (workflowContent.includes('npm run check') && workflowContent.includes('npm test')),
    'workflow must run npm run ci or both npm run check and npm test'
  );
});
