import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('docker image workflow builds production-configured immutable images', async () => {
  const workflow = await readFile('.github/workflows/docker-build.yaml', 'utf8');

  assert.match(workflow, /type=sha,format=long/);
  assert.match(workflow, /push:\s*\$\{\{\s*github\.event_name != 'pull_request'\s*\}\}/);
  assert.match(workflow, /NEXT_PUBLIC_APP_URL:\s*https:\/\/apipool\.dev/);
  assert.match(workflow, /NEXT_PUBLIC_APIPOOL_API_BASE_URL:\s*https:\/\/api\.apipool\.dev\/v1/);
  assert.match(workflow, /NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL:\s*gpt-5\.4-mini/);
  assert.match(workflow, /deploy-production:/);
  assert.match(workflow, /IMAGE_TAG:\s*sha-\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /docker login ghcr\.io/);
  assert.match(workflow, /\.\/deploy\/deploy\.sh '\$IMAGE_TAG'/);
});

test('production compose pulls a selected GHCR image tag', async () => {
  const compose = await readFile('docker-compose.prod.yml', 'utf8');

  assert.match(compose, /ghcr\.io\/afreecoder\/apipool-v2/);
  assert.match(compose, /\$\{IMAGE_TAG:\?IMAGE_TAG is required\}/);
  assert.doesNotMatch(compose, /^\s*build:/m);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /127\.0\.0\.1:3001:3000/);
});

test('deploy script backs up before pulling and deploying', async () => {
  const script = await readFile('deploy/deploy.sh', 'utf8');

  const backupIndex = script.indexOf('./deploy/backup.sh pre-deploy');
  const pullIndex = script.indexOf('compose pull');
  const upIndex = script.indexOf('compose up -d --remove-orphans');

  assert.ok(backupIndex >= 0, 'pre-deploy backup should be present');
  assert.ok(pullIndex > backupIndex, 'image pull should happen after backup');
  assert.ok(upIndex > pullIndex, 'container update should happen after pull');
  assert.match(script, /http:\/\/127\.0\.0\.1:3001\/api\/status/);
  assert.match(script, /http:\/\/127\.0\.0\.1:3000\//);
});

test('backup script has separate pre-deploy and daily retention rules', async () => {
  const script = await readFile('deploy/backup.sh', 'utf8');

  assert.match(script, /pre-deploy\).*APIPOOL_PRE_DEPLOY_BACKUP_RETAIN:-2/);
  assert.match(script, /daily\).*APIPOOL_DAILY_BACKUP_RETAIN_DAYS:-7/);
  assert.match(script, /docker compose .* pause/);
  assert.match(script, /chmod 600 "\$archive"/);
  assert.match(script, /-mtime \+"\$\(\(RETAIN_DAYS - 1\)\)"/);
});

test('systemd timer runs daily backup at 04:00 Asia/Shanghai', async () => {
  const timer = await readFile('deploy/systemd/apipool-v2-backup.timer', 'utf8');
  const service = await readFile('deploy/systemd/apipool-v2-backup.service', 'utf8');

  assert.match(timer, /OnCalendar=\*-\*-\* 04:00:00 Asia\/Shanghai/);
  assert.match(timer, /Persistent=true/);
  assert.match(service, /ExecStart=\/opt\/apipool-v2\/deploy\/backup\.sh daily/);
});

test('Caddy setup routes public subdomains to local containers without Caddy auth', async () => {
  const script = await readFile('deploy/configure-caddy.sh', 'utf8');
  const bootstrap = await readFile('deploy/server-bootstrap.sh', 'utf8');

  assert.match(script, /new\.apipool\.dev/);
  assert.match(script, /newapi\.apipool\.dev/);
  assert.match(script, /reverse_proxy \$PORTAL_UPSTREAM/);
  assert.match(script, /reverse_proxy \$NEWAPI_UPSTREAM/);
  assert.doesNotMatch(script, /basicauth/);
  assert.match(script, /X-Robots-Tag "noindex, nofollow"/);
  assert.match(bootstrap, /configure-caddy\.sh/);
});
