import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('CI builds and tests the metadata filter alongside the portal', async () => {
  const [buildWorkflow, verifyWorkflow] = await Promise.all([
    readFile('.github/workflows/docker-build.yaml', 'utf8'),
    readFile('.github/workflows/mvp-verify.yaml', 'utf8'),
  ]);

  assert.match(buildWorkflow, /METADATA_FILTER_IMAGE:\s*ghcr\.io\/afreecoder\/apipool-v2-newapi-metadata-filter/);
  assert.match(buildWorkflow, /id:\s*metadata-filter-meta/);
  assert.match(buildWorkflow, /context:\s*\.\/services\/newapi-metadata-filter/);
  assert.match(buildWorkflow, /tags:\s*\$\{\{\s*steps\.metadata-filter-meta\.outputs\.tags\s*\}\}/);
  assert.match(buildWorkflow, /docker-compose\.prod\.yml deploy services\/newapi-metadata-filter\/config/);

  assert.match(verifyWorkflow, /actions\/setup-go@v6/);
  assert.match(verifyWorkflow, /go-version:\s*['"]1\.26\.0['"]/);
  assert.match(verifyWorkflow, /working-directory:\s*services\/newapi-metadata-filter/);
  assert.match(verifyWorkflow, /run:\s*go test \.\/\.\.\./);
});

test('production deployment waits for the internal filter before NewAPI', async () => {
  const deploy = await readFile('deploy/deploy.sh', 'utf8');

  const filterWait = deploy.indexOf('waiting for NewAPI metadata filter');
  const newAPIWait = deploy.indexOf('waiting for New API');
  assert.ok(filterWait >= 0, 'missing metadata filter health gate');
  assert.ok(newAPIWait > filterWait, 'filter must be checked before NewAPI');
  assert.match(deploy, /compose ps -q newapi-metadata-filter/);
  assert.match(deploy, /\.State\.Health\.Status/);
});
