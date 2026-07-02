import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('docker image workflow builds production-configured immutable images', async () => {
  const workflow = await readFile(
    '.github/workflows/docker-build.yaml',
    'utf8'
  );

  assert.match(workflow, /type=sha,format=long/);
  assert.match(
    workflow,
    /push:\s*\$\{\{\s*github\.event_name != 'pull_request'\s*\}\}/
  );
  assert.match(workflow, /NEXT_PUBLIC_APP_URL:\s*https:\/\/app\.apipool\.dev/);
  assert.match(
    workflow,
    /NEXT_PUBLIC_APIPOOL_API_BASE_URL:\s*https:\/\/api2\.apipool\.dev$/m
  );
  assert.match(workflow, /NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL:\s*gpt-5\.4-mini/);
  assert.match(workflow, /deploy-production:/);
  assert.match(workflow, /IMAGE_TAG:\s*sha-\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /docker login ghcr\.io/);
  assert.match(workflow, /\.\/deploy\/deploy\.sh '\$IMAGE_TAG'/);
});

test('GitHub workflows use Node 24-compatible actions without changing release semantics', async () => {
  const dockerWorkflow = await readFile(
    '.github/workflows/docker-build.yaml',
    'utf8'
  );
  const verifyWorkflow = await readFile(
    '.github/workflows/mvp-verify.yaml',
    'utf8'
  );
  const workflows = `${dockerWorkflow}\n${verifyWorkflow}`;

  for (const action of [
    'actions/checkout@v7',
    'actions/setup-node@v6',
    'pnpm/action-setup@v6',
    'docker/login-action@v4',
    'docker/metadata-action@v6',
    'docker/build-push-action@v7',
  ]) {
    assert.match(workflows, new RegExp(action.replace('/', '\\/')));
  }

  for (const oldAction of [
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'pnpm/action-setup@v4',
    'docker/login-action@v3',
    'docker/metadata-action@v5',
    'docker/build-push-action@v5',
  ]) {
    assert.doesNotMatch(workflows, new RegExp(oldAction.replace('/', '\\/')));
  }

  assert.match(dockerWorkflow, /runs-on:\s*ubuntu-latest/);
  assert.match(verifyWorkflow, /runs-on:\s*ubuntu-latest/);
  assert.match(dockerWorkflow, /branches:\s*\[['"]main['"], ['"]dev['"]\]/);
  assert.match(verifyWorkflow, /branches:\s*\[['"]main['"], ['"]dev['"]\]/);
  assert.match(
    dockerWorkflow,
    /push:\s*\$\{\{\s*github\.event_name != 'pull_request'\s*\}\}/
  );
  assert.match(
    dockerWorkflow,
    /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/
  );
  assert.match(dockerWorkflow, /type=sha,format=long/);
  assert.match(dockerWorkflow, /\.\/deploy\/deploy\.sh '\$IMAGE_TAG'/);
  assert.equal(
    [...verifyWorkflow.matchAll(/node-version:\s*['"]22['"]/g)].length,
    2
  );
});

test('New API option repair script is documented and guarded', async () => {
  const script = await readFile('deploy/repair-newapi-options.sh', 'utf8');

  assert.match(script, /APIPOOL_REPAIR_LOCK/);
  assert.match(script, /apipool-v2-deploy\.lock/);
  assert.match(script, /apipool-v2-backup\.lock/);
  assert.match(script, /BEGIN IMMEDIATE/);
  assert.match(script, /PRAGMA busy_timeout=5000/);
  assert.match(script, /rollback sql:/);
  assert.match(script, /json_type\(value\)/);
  assert.match(script, /theme\.frontend/);
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
  const timer = await readFile(
    'deploy/systemd/apipool-v2-backup.timer',
    'utf8'
  );
  const service = await readFile(
    'deploy/systemd/apipool-v2-backup.service',
    'utf8'
  );

  assert.match(timer, /OnCalendar=\*-\*-\* 04:00:00 Asia\/Shanghai/);
  assert.match(timer, /Persistent=true/);
  assert.match(
    service,
    /ExecStart=\/opt\/apipool-v2\/deploy\/backup\.sh daily/
  );
});

test('Caddy setup routes public subdomains to local containers without Caddy auth', async () => {
  const script = await readFile('deploy/configure-caddy.sh', 'utf8');
  const bootstrap = await readFile('deploy/server-bootstrap.sh', 'utf8');

  assert.match(script, /app\.apipool\.dev/);
  assert.match(script, /api2\.apipool\.dev/);
  assert.match(script, /newapi\.apipool\.dev/);
  assert.match(script, /reverse_proxy \$PORTAL_UPSTREAM/);
  assert.match(script, /reverse_proxy \$API_UPSTREAM/);
  assert.match(script, /reverse_proxy \$NEWAPI_UPSTREAM/);
  assert.doesNotMatch(script, /basicauth/);
  assert.match(script, /X-Robots-Tag "noindex, nofollow"/);
  assert.match(bootstrap, /configure-caddy\.sh/);
});
