import { revalidateTag, unstable_cache } from 'next/cache';

import { envConfigs } from '@/config';
import { config } from '@/config/db/schema';
import { db } from '@/core/db';
import { isCloudflareWorker } from '@/shared/lib/env';
import {
  getAllSettingNames,
  publicSettingNames,
} from '@/shared/services/settings';

export type Config = typeof config.$inferSelect;
export type NewConfig = typeof config.$inferInsert;
export type UpdateConfig = Partial<Omit<NewConfig, 'name'>>;

export type Configs = Record<string, string>;

export const CACHE_TAG_CONFIGS = 'configs';

export async function saveConfigs(configs: Record<string, string>) {
  const database = db();
  const configEntries = Object.entries(configs);

  // D1: use batch() to send all upserts in a single round-trip
  if (envConfigs.database_provider === 'd1') {
    const queries = configEntries.map(([name, configValue]) =>
      database
        .insert(config)
        .values({ name, value: configValue })
        .onConflictDoUpdate({
          target: config.name,
          set: { value: configValue },
        })
        .returning()
    );

    const batchResults =
      queries.length > 0 ? await database.batch(queries) : [];
    revalidateTag(CACHE_TAG_CONFIGS, 'max');
    return batchResults.flat();
  }

  // Other databases: use transaction for atomicity
  const result = await database.transaction(async (tx: any) => {
    const results: any[] = [];

    for (const [name, configValue] of configEntries) {
      const [upsertResult] = await tx
        .insert(config)
        .values({ name, value: configValue })
        .onConflictDoUpdate({
          target: config.name,
          set: { value: configValue },
        })
        .returning();

      results.push(upsertResult);
    }

    return results;
  });

  revalidateTag(CACHE_TAG_CONFIGS, 'max');

  return result;
}

export async function addConfig(newConfig: NewConfig) {
  const [result] = await db().insert(config).values(newConfig).returning();
  revalidateTag(CACHE_TAG_CONFIGS, 'max');

  return result;
}

export const getConfigs = unstable_cache(
  async (): Promise<Configs> => {
    const configs: Record<string, string> = {};

    // D1 is only available inside Cloudflare Workers runtime (not during build)
    if (envConfigs.database_provider === 'd1' && !isCloudflareWorker) {
      return configs;
    }
    if (!envConfigs.database_url && envConfigs.database_provider !== 'd1') {
      return configs;
    }

    const result = await db().select().from(config);
    if (!result) {
      return configs;
    }

    for (const config of result) {
      configs[config.name] = config.value ?? '';
    }

    return configs;
  },
  ['configs'],
  {
    revalidate: 3600,
    tags: [CACHE_TAG_CONFIGS],
  }
);

export async function getAllConfigs(): Promise<Configs> {
  let dbConfigs: Configs = {};

  // only get configs from db in server side
  const hasDb =
    envConfigs.database_url ||
    (envConfigs.database_provider === 'd1' && isCloudflareWorker);
  if (typeof window === 'undefined' && hasDb) {
    try {
      dbConfigs = await getConfigs();
    } catch (e) {
      console.log(`get configs from db failed:`, e);
      dbConfigs = {};
    }
  }

  const settingNames = await getAllSettingNames();
  settingNames.forEach((key) => {
    const upperKey = key.toUpperCase();
    // use env configs if available
    if (process.env[upperKey]) {
      dbConfigs[key] = process.env[upperKey] ?? '';
    } else if (process.env[key]) {
      dbConfigs[key] = process.env[key] ?? '';
    }
  });

  const configs = {
    ...envConfigs,
    ...dbConfigs,
  };

  return configs;
}

/**
 * 注入 <head>/<body> 脚本的服务（ads / analytics / affiliate / 客服）所需的键。
 *
 * root layout 原先直接把 getAllConfigs() 递给它们——那个对象含 stripe_secret_key、
 * NEWAPI_ADMIN_TOKEN 等全部密钥。今天这些服务只读公开 ID，但只要有人多读一个键
 * 就会把密钥拼进页面脚本。这里显式收窄，让密钥根本不进入调用面。
 */
const SCRIPT_INJECTION_CONFIG_KEYS = [
  'adsense_code',
  'google_analytics_id',
  'openpanel_client_id',
  'plausible_domain',
  'plausible_src',
  'clarity_id',
  'vercel_analytics_enabled',
  'affonso_enabled',
  'affonso_id',
  'affonso_cookie_duration',
  'promotekit_enabled',
  'promotekit_id',
  'crisp_enabled',
  'crisp_website_id',
  'tawk_enabled',
  'tawk_property_id',
  'tawk_widget_id',
] as const;

export async function getScriptInjectionConfigs(): Promise<Configs> {
  const allConfigs = await getAllConfigs();
  const configs: Record<string, string> = {};

  for (const key of SCRIPT_INJECTION_CONFIG_KEYS) {
    const value = allConfigs[key];
    if (value !== undefined && value !== null) {
      configs[key] = String(value);
    }
  }

  return configs;
}

export async function getPublicConfigs(): Promise<Configs> {
  let allConfigs = await getAllConfigs();

  const publicConfigs: Record<string, string> = {};

  // get public configs
  for (const key in allConfigs) {
    if (publicSettingNames.includes(key)) {
      publicConfigs[key] = String(allConfigs[key]);
    }
  }

  const configs = {
    ...publicConfigs,
  };

  return configs;
}
