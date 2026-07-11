import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function serviceBlock(compose: string, name: string) {
  const match = compose.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm')
  );
  assert.ok(match, `missing ${name} service`);
  return match[1];
}

test('Compose routes NewAPI metadata sync through an internal healthy filter', async () => {
  const [localCompose, productionCompose, productionEnv] = await Promise.all([
    readFile('docker-compose.yml', 'utf8'),
    readFile('docker-compose.prod.yml', 'utf8'),
    readFile('deploy/env.production.example', 'utf8'),
  ]);

  for (const compose of [localCompose, productionCompose]) {
    const filter = serviceBlock(compose, 'newapi-metadata-filter');
    const newAPI = serviceBlock(compose, 'new-api');

    assert.doesNotMatch(filter, /^\s+ports:/m);
    assert.match(newAPI, /SYNC_UPSTREAM_BASE:\s*http:\/\/newapi-metadata-filter:8080/);
    assert.match(
      newAPI,
      /depends_on:\s*\n\s+newapi-metadata-filter:\s*\n\s+condition:\s+service_healthy/
    );
  }

  assert.match(serviceBlock(localCompose, 'newapi-metadata-filter'), /context:\s*\.\/services\/newapi-metadata-filter/);
  assert.match(serviceBlock(localCompose, 'newapi-metadata-filter'), /official-vendors\.yaml:ro/);
  assert.match(serviceBlock(productionCompose, 'newapi-metadata-filter'), /NEWAPI_METADATA_FILTER_IMAGE/);
  assert.doesNotMatch(serviceBlock(productionCompose, 'newapi-metadata-filter'), /^\s+volumes:/m);
  assert.match(productionEnv, /NEWAPI_METADATA_FILTER_IMAGE=ghcr\.io\/afreecoder\/apipool-v2-newapi-metadata-filter/);
});
