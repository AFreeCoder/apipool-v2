import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = 'deploy/repair-newapi-options.sh';

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function sqlValue(value: string | null) {
  if (value === null) {
    return 'NULL';
  }

  return `'${value.replaceAll("'", "''")}'`;
}

async function runSql(dbPath: string, sql: string) {
  await execFileAsync('sqlite3', [dbPath, sql]);
}

async function querySql(dbPath: string, sql: string) {
  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql]);
  return JSON.parse(stdout || '[]') as Array<Record<string, unknown>>;
}

async function createOptionsDb(
  entries: Record<string, string | null>,
  options: { createTable?: boolean } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'apipool-newapi-options-'));
  const dbPath = join(dir, 'one-api.db');

  if (options.createTable !== false) {
    await runSql(
      dbPath,
      'create table options (key text primary key, value text);'
    );

    for (const [key, value] of Object.entries(entries)) {
      await runSql(
        dbPath,
        `insert into options(key, value) values (${sqlValue(key)}, ${sqlValue(
          value
        )});`
      );
    }
  }

  return {
    dbPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function runRepair(args: string[] = []): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [
      scriptPath,
      ...args,
    ]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}

const validBaseOptions = {
  GroupRatio: '{"official":1}',
  TopupGroupRatio: '{}',
  UserUsableGroups: '{"official":"官方分组"}',
  AutoGroups: '["official"]',
  'theme.frontend': 'default',
};

test('New API option repair dry-run reports known empty maps without changing data', async () => {
  const db = await createOptionsDb({
    ...validBaseOptions,
    GroupGroupRatio: '',
    'group_ratio_setting.group_special_usable_group': '',
  });

  try {
    const result = await runRepair(['--db', db.dbPath]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /would repair GroupGroupRatio/);
    assert.match(
      result.stdout,
      /would repair group_ratio_setting\.group_special_usable_group/
    );
    assert.doesNotMatch(result.stdout + result.stderr, /theme\.frontend/);

    const rows = await querySql(
      db.dbPath,
      "select key, quote(value) as quoted from options where key in ('GroupGroupRatio', 'group_ratio_setting.group_special_usable_group') order by key;"
    );
    assert.deepEqual(rows, [
      { key: 'GroupGroupRatio', quoted: "''" },
      {
        key: 'group_ratio_setting.group_special_usable_group',
        quoted: "''",
      },
    ]);
  } finally {
    await db.cleanup();
  }
});

test('New API option repair apply fixes empty maps, emits rollback SQL, and is idempotent', async () => {
  const db = await createOptionsDb({
    ...validBaseOptions,
    GroupGroupRatio: null,
  });

  try {
    const first = await runRepair(['--db', db.dbPath, '--apply']);

    assert.equal(first.code, 0);
    assert.match(first.stdout, /applied repair GroupGroupRatio/);
    assert.match(
      first.stdout,
      /applied repair group_ratio_setting\.group_special_usable_group/
    );
    assert.match(first.stdout, /rollback sql:/);
    assert.match(first.stdout, /rollback sha256:/);

    const rows = await querySql(
      db.dbPath,
      "select key, value, json_valid(value) as json_valid, json_type(value) as json_type from options where key in ('GroupGroupRatio', 'group_ratio_setting.group_special_usable_group') order by key;"
    );
    assert.deepEqual(rows, [
      {
        key: 'GroupGroupRatio',
        value: '{}',
        json_valid: 1,
        json_type: 'object',
      },
      {
        key: 'group_ratio_setting.group_special_usable_group',
        value: '{}',
        json_valid: 1,
        json_type: 'object',
      },
    ]);

    const second = await runRepair(['--db', db.dbPath, '--apply']);
    assert.equal(second.code, 0);
    assert.match(second.stdout, /no repair needed/);
  } finally {
    await db.cleanup();
  }
});

test('New API option repair preserves existing operator-provided object maps', async () => {
  const groupGroupRatio = '{"vip":{"official":0.9}}';
  const specialUsableGroup = '{"vip":{"append_1":"vip_special_group_1"}}';
  const db = await createOptionsDb({
    ...validBaseOptions,
    GroupGroupRatio: groupGroupRatio,
    'group_ratio_setting.group_special_usable_group': specialUsableGroup,
  });

  try {
    const result = await runRepair(['--db', db.dbPath, '--apply']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /no repair needed/);

    const rows = await querySql(
      db.dbPath,
      "select key, value from options where key in ('GroupGroupRatio', 'group_ratio_setting.group_special_usable_group') order by key;"
    );
    assert.deepEqual(rows, [
      { key: 'GroupGroupRatio', value: groupGroupRatio },
      {
        key: 'group_ratio_setting.group_special_usable_group',
        value: specialUsableGroup,
      },
    ]);
  } finally {
    await db.cleanup();
  }
});

test('New API option repair rejects non-repairable invalid JSON and wrong JSON types before writing', async () => {
  for (const [key, value] of [
    ['GroupRatio', ''],
    ['GroupRatio', '[]'],
    ['AutoGroups', '{}'],
  ] as const) {
    const db = await createOptionsDb({
      ...validBaseOptions,
      [key]: value,
      GroupGroupRatio: '',
      'group_ratio_setting.group_special_usable_group': '',
    });

    try {
      const result = await runRepair(['--db', db.dbPath, '--apply']);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr + result.stdout, new RegExp(key));
      assert.match(result.stderr + result.stdout, /invalid New API option/);

      const rows = await querySql(
        db.dbPath,
        "select key, quote(value) as quoted from options where key in ('GroupGroupRatio', 'group_ratio_setting.group_special_usable_group') order by key;"
      );
      assert.deepEqual(rows, [
        { key: 'GroupGroupRatio', quoted: "''" },
        {
          key: 'group_ratio_setting.group_special_usable_group',
          quoted: "''",
        },
      ]);
    } finally {
      await db.cleanup();
    }
  }
});

test('New API option repair fails before writes when options table is missing', async () => {
  const db = await createOptionsDb({}, { createTable: false });

  try {
    await runSql(db.dbPath, 'create table unrelated (id integer primary key);');

    const result = await runRepair(['--db', db.dbPath, '--apply']);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /options table/);
  } finally {
    await db.cleanup();
  }
});
