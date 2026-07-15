import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// SQLite has no schema concept like Postgres. Keep a `table` alias to minimize diff with pg schema.
const table = sqliteTable;

// SQLite "now" in epoch milliseconds (same expression drizzle used in `defaultNow()`).
const sqliteNowMs = sql`(cast((julianday('now') - 2440587.5)*86400000 as integer))`;

export const user = table(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' })
      .default(false)
      .notNull(),
    image: text('image'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    // Track first-touch acquisition channel (e.g. google, twitter, newsletter)
    utmSource: text('utm_source').notNull().default(''),
    ip: text('ip').notNull().default(''),
    locale: text('locale').notNull().default(''),
  },
  (table) => [
    // Search users by name in admin dashboard
    index('idx_user_name').on(table.name),
    // Order users by registration time for latest users list
    index('idx_user_created_at').on(table.createdAt),
  ]
);

export const session = table(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    // Composite: Query user sessions and filter by expiration
    // Can also be used for: WHERE userId = ? (left-prefix)
    index('idx_session_user_expires').on(table.userId, table.expiresAt),
  ]
);

export const account = table(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // Query all linked accounts for a user
    index('idx_account_user_id').on(table.userId),
    // Composite: OAuth login (most critical)
    // Can also be used for: WHERE providerId = ? (left-prefix)
    index('idx_account_provider_account').on(table.providerId, table.accountId),
  ]
);

export const verification = table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // Find verification code by identifier (e.g., find code by email)
    index('idx_verification_identifier').on(table.identifier),
  ]
);

export const config = table('config', {
  name: text('name').unique().notNull(),
  value: text('value'),
});

export const taxonomy = table(
  'taxonomy',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    slug: text('slug').unique().notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    image: text('image'),
    icon: text('icon'),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [
    // Composite: Query taxonomies by type and status
    // Can also be used for: WHERE type = ? (left-prefix)
    index('idx_taxonomy_type_status').on(table.type, table.status),
  ]
);

export const post = table(
  'post',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    slug: text('slug').unique().notNull(),
    type: text('type').notNull(),
    title: text('title'),
    description: text('description'),
    image: text('image'),
    content: text('content'),
    categories: text('categories'),
    tags: text('tags'),
    authorName: text('author_name'),
    authorImage: text('author_image'),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [
    // Composite: Query posts by type and status
    // Can also be used for: WHERE type = ? (left-prefix)
    index('idx_post_type_status').on(table.type, table.status),
  ]
);

export const order = table(
  'order',
  {
    id: text('id').primaryKey(),
    orderNo: text('order_no').unique().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email'), // checkout user email
    status: text('status').notNull(), // created, paid, failed
    amount: integer('amount').notNull(), // checkout amount in cents
    currency: text('currency').notNull(), // checkout currency
    productId: text('product_id'),
    paymentType: text('payment_type'), // one_time, subscription
    paymentInterval: text('payment_interval'), // day, week, month, year
    paymentProvider: text('payment_provider').notNull(),
    paymentSessionId: text('payment_session_id'),
    checkoutInfo: text('checkout_info').notNull(), // checkout request info
    checkoutResult: text('checkout_result'), // checkout result
    paymentResult: text('payment_result'), // payment result
    discountCode: text('discount_code'), // discount code
    discountAmount: integer('discount_amount'), // discount amount in cents
    discountCurrency: text('discount_currency'), // discount currency
    paymentEmail: text('payment_email'), // actual payment email
    paymentAmount: integer('payment_amount'), // actual payment amount
    paymentCurrency: text('payment_currency'), // actual payment currency
    paidAt: integer('paid_at', { mode: 'timestamp_ms' }), // paid at
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    description: text('description'), // order description
    productName: text('product_name'), // product name
    subscriptionId: text('subscription_id'), // provider subscription id
    subscriptionResult: text('subscription_result'), // provider subscription result
    checkoutUrl: text('checkout_url'), // checkout url
    callbackUrl: text('callback_url'), // callback url, after handle callback
    creditsAmount: integer('credits_amount'), // credits amount
    creditsValidDays: integer('credits_valid_days'), // credits validity days
    planName: text('plan_name'), // subscription plan name
    paymentProductId: text('payment_product_id'), // payment product id
    invoiceId: text('invoice_id'),
    invoiceUrl: text('invoice_url'),
    subscriptionNo: text('subscription_no'), // order subscription no
    transactionId: text('transaction_id'), // payment transaction id
    paymentUserName: text('payment_user_name'), // payment user name
    paymentUserId: text('payment_user_id'), // payment user id
  },
  (table) => [
    // Composite: Query user orders by status (most common)
    // Can also be used for: WHERE userId = ? (left-prefix)
    index('idx_order_user_status_payment_type').on(
      table.userId,
      table.status,
      table.paymentType
    ),
    // Composite: Prevent duplicate payments
    // Can also be used for: WHERE transactionId = ? (left-prefix)
    index('idx_order_transaction_provider').on(
      table.transactionId,
      table.paymentProvider
    ),
    // Order orders by creation time for listing
    index('idx_order_created_at').on(table.createdAt),
  ]
);

export const subscription = table(
  'subscription',
  {
    id: text('id').primaryKey(),
    subscriptionNo: text('subscription_no').unique().notNull(), // subscription no
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email'), // subscription user email
    status: text('status').notNull(), // subscription status
    paymentProvider: text('payment_provider').notNull(),
    subscriptionId: text('subscription_id').notNull(), // provider subscription id
    subscriptionResult: text('subscription_result'), // provider subscription result
    productId: text('product_id'), // product id
    description: text('description'), // subscription description
    amount: integer('amount'), // subscription amount
    currency: text('currency'), // subscription currency
    interval: text('interval'), // subscription interval, day, week, month, year
    intervalCount: integer('interval_count'), // subscription interval count
    trialPeriodDays: integer('trial_period_days'), // subscription trial period days
    currentPeriodStart: integer('current_period_start', {
      mode: 'timestamp_ms',
    }), // subscription current period start
    currentPeriodEnd: integer('current_period_end', { mode: 'timestamp_ms' }), // subscription current period end
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    planName: text('plan_name'),
    billingUrl: text('billing_url'),
    productName: text('product_name'), // subscription product name
    creditsAmount: integer('credits_amount'), // subscription credits amount
    creditsValidDays: integer('credits_valid_days'), // subscription credits valid days
    paymentProductId: text('payment_product_id'), // subscription payment product id
    paymentUserId: text('payment_user_id'), // subscription payment user id
    canceledAt: integer('canceled_at', { mode: 'timestamp_ms' }), // subscription canceled apply at
    canceledEndAt: integer('canceled_end_at', { mode: 'timestamp_ms' }), // subscription canceled end at
    canceledReason: text('canceled_reason'), // subscription canceled reason
    canceledReasonType: text('canceled_reason_type'), // subscription canceled reason type
  },
  (table) => [
    // Composite: Query user's subscriptions by status (most common)
    // Can also be used for: WHERE userId = ? (left-prefix)
    index('idx_subscription_user_status_interval').on(
      table.userId,
      table.status,
      table.interval
    ),
    // Composite: Prevent duplicate subscriptions
    // Can also be used for: WHERE paymentProvider = ? (left-prefix)
    index('idx_subscription_provider_id').on(
      table.subscriptionId,
      table.paymentProvider
    ),
    // Order subscriptions by creation time for listing
    index('idx_subscription_created_at').on(table.createdAt),
  ]
);

export const credit = table(
  'credit',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }), // user id
    userEmail: text('user_email'), // user email
    orderNo: text('order_no'), // payment order no
    subscriptionNo: text('subscription_no'), // subscription no
    transactionNo: text('transaction_no').unique().notNull(), // transaction no
    transactionType: text('transaction_type').notNull(), // transaction type, grant / consume
    transactionScene: text('transaction_scene'), // transaction scene, payment / subscription / gift / award
    credits: integer('credits').notNull(), // credits amount, n or -n
    remainingCredits: integer('remaining_credits').notNull().default(0), // remaining credits amount
    description: text('description'), // transaction description
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }), // transaction expires at
    status: text('status').notNull(), // transaction status
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    consumedDetail: text('consumed_detail'), // consumed detail
    metadata: text('metadata'), // transaction metadata
  },
  (table) => [
    // Critical composite index for credit consumption (FIFO queue)
    // Query: WHERE userId = ? AND transactionType = 'grant' AND status = 'active'
    //        AND remainingCredits > 0 ORDER BY expiresAt
    // Can also be used for: WHERE userId = ? (left-prefix)
    index('idx_credit_consume_fifo').on(
      table.userId,
      table.status,
      table.transactionType,
      table.remainingCredits,
      table.expiresAt
    ),
    // Query credits by order number
    index('idx_credit_order_no').on(table.orderNo),
    // Query credits by subscription number
    index('idx_credit_subscription_no').on(table.subscriptionNo),
  ]
);

export const apikey = table(
  'apikey',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    // Composite: Query user's API keys by status
    // Can also be used for: WHERE userId = ? (left-prefix)
    index('idx_apikey_user_status').on(table.userId, table.status),
    // Composite: Validate active API key (most common for auth)
    // Can also be used for: WHERE key = ? (left-prefix)
    index('idx_apikey_key_status').on(table.key, table.status),
  ]
);

export const catalogVendor = table(
  'catalog_vendor',
  {
    id: text('id').primaryKey(),
    slug: text('slug').unique().notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    status: text('status').default('active').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('idx_catalog_vendor_status').on(table.status)]
);

export const catalogCategory = table(
  'catalog_category',
  {
    id: text('id').primaryKey(),
    slug: text('slug').unique().notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    status: text('status').default('active').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('idx_catalog_category_status').on(table.status)]
);

export const catalogCapability = table('catalog_capability', {
  id: text('id').primaryKey(),
  slug: text('slug').unique().notNull(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  status: text('status').default('active').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sqliteNowMs)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sqliteNowMs)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const catalogStatus = table('catalog_status', {
  id: text('id').primaryKey(),
  slug: text('slug').unique().notNull(),
  name: text('name').notNull(),
  isCallable: integer('is_callable', { mode: 'boolean' })
    .default(false)
    .notNull(),
  isPublicVisible: integer('is_public_visible', { mode: 'boolean' })
    .default(true)
    .notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  status: text('status').default('active').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sqliteNowMs)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sqliteNowMs)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const catalogGroup = table(
  'catalog_group',
  {
    id: text('id').primaryKey(),
    slug: text('slug').unique().notNull(),
    name: text('name').notNull(),
    userDescription: text('user_description'),
    newapiGroup: text('newapi_group').default('').notNull(),
    newapiGroupRatioDecimal: text('newapi_group_ratio_decimal'),
    newapiGroupRatioBps: integer('newapi_group_ratio_bps'),
    newapiGroupRatioRaw: text('newapi_group_ratio_raw'),
    pricingSyncStatus: text('pricing_sync_status').default('unknown').notNull(),
    pricingSyncedAt: integer('pricing_synced_at', { mode: 'timestamp_ms' }),
    pricingReviewNote: text('pricing_review_note'),
    allowCreateKey: integer('allow_create_key', { mode: 'boolean' })
      .default(true)
      .notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    status: text('status').default('active').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('idx_catalog_group_status').on(table.status)]
);

export const catalogModel = table(
  'catalog_model',
  {
    id: text('id').primaryKey(),
    modelId: text('model_id').unique().notNull(),
    displayName: text('display_name').notNull(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => catalogVendor.id),
    category: text('category').default('llm').notNull(),
    contextWindow: integer('context_window'),
    // 展示用最大输出（发布最坏成本计算要求非空，见 routing-admin）
    maxOutputTokens: integer('max_output_tokens'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('idx_catalog_model_vendor').on(table.vendorId)]
);

export const catalogModelPrice = table(
  'catalog_model_price',
  {
    id: text('id').primaryKey(),
    modelId: text('model_id')
      .notNull()
      .references(() => catalogModel.id, { onDelete: 'cascade' }),
    pricingMode: text('pricing_mode').default('unknown').notNull(),
    source: text('source').default('migration').notNull(),
    sourceModelId: text('source_model_id'),
    sourceVendorId: text('source_vendor_id'),
    sourceQuotaType: integer('source_quota_type'),
    sourceModelRatio: text('source_model_ratio'),
    sourceCompletionRatio: text('source_completion_ratio'),
    sourceImageRatio: text('source_image_ratio'),
    sourceSupportedEndpointTypes: text('source_supported_endpoint_types'),
    baseInputMicroUsd: integer('base_input_micro_usd'),
    baseOutputMicroUsd: integer('base_output_micro_usd'),
    // cache 维度基准价（micro-USD / 1M tokens；管理员锁定+复核的成本快照）
    baseCachedInputMicroUsd: integer('base_cached_input_micro_usd'),
    baseCacheWrite5mMicroUsd: integer('base_cache_write_5m_micro_usd'),
    baseCacheWrite1hMicroUsd: integer('base_cache_write_1h_micro_usd'),
    cachePriceNote: text('cache_price_note'),
    baseImageInputMicroUsd: integer('base_image_input_micro_usd'),
    baseImageOutputMicroUsd: integer('base_image_output_micro_usd'),
    fixedPriceMicroUsd: integer('fixed_price_micro_usd'),
    fixedPriceUnit: text('fixed_price_unit'),
    syncStatus: text('sync_status').default('never_synced').notNull(),
    driftStatus: text('drift_status').default('unknown').notNull(),
    sourceFingerprint: text('source_fingerprint'),
    sourceSyncedAt: integer('source_synced_at', { mode: 'timestamp_ms' }),
    reviewedBy: text('reviewed_by'),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
    reviewNote: text('review_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_catalog_model_price_model').on(table.modelId),
    index('idx_catalog_model_price_sync_status').on(table.syncStatus),
    index('idx_catalog_model_price_drift_status').on(table.driftStatus),
    index('idx_catalog_model_price_source_model').on(table.sourceModelId),
  ]
);

export const catalogModelCapability = table(
  'catalog_model_capability',
  {
    id: text('id').primaryKey(),
    modelId: text('model_id')
      .notNull()
      .references(() => catalogModel.id, { onDelete: 'cascade' }),
    capabilityId: text('capability_id')
      .notNull()
      .references(() => catalogCapability.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('uniq_catalog_model_capability').on(
      table.modelId,
      table.capabilityId
    ),
    index('idx_cmc_capability').on(table.capabilityId),
  ]
);

export const catalogModelCategory = table(
  'catalog_model_category',
  {
    id: text('id').primaryKey(),
    modelId: text('model_id')
      .notNull()
      .references(() => catalogModel.id, { onDelete: 'cascade' }),
    categoryId: text('category_id')
      .notNull()
      .references(() => catalogCategory.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('uniq_catalog_model_category').on(
      table.modelId,
      table.categoryId
    ),
    index('idx_cmc_category').on(table.categoryId),
  ]
);

export const catalogModelListing = table(
  'catalog_model_listing',
  {
    id: text('id').primaryKey(),
    modelId: text('model_id')
      .notNull()
      .references(() => catalogModel.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => catalogGroup.id, { onDelete: 'cascade' }),
    statusId: text('status_id')
      .notNull()
      .references(() => catalogStatus.id),
    inputMicroUsd: integer('input_micro_usd').notNull(),
    outputMicroUsd: integer('output_micro_usd').notNull(),
    imageInputMicroUsd: integer('image_input_micro_usd'),
    imageOutputMicroUsd: integer('image_output_micro_usd'),
    listInputMicroUsd: integer('list_input_micro_usd'),
    listOutputMicroUsd: integer('list_output_micro_usd'),
    discountRateBps: integer('discount_rate_bps'),
    discountNote: text('discount_note'),
    pricePolicy: text('price_policy').default('inherit_group').notNull(),
    overrideInputMicroUsd: integer('override_input_micro_usd'),
    overrideOutputMicroUsd: integer('override_output_micro_usd'),
    overrideImageInputMicroUsd: integer('override_image_input_micro_usd'),
    overrideImageOutputMicroUsd: integer('override_image_output_micro_usd'),
    overrideReason: text('override_reason'),
    overrideStatus: text('override_status').default('none').notNull(),
    effectivePriceSyncedAt: integer('effective_price_synced_at', {
      mode: 'timestamp_ms',
    }),
    effectivePriceFormula: text('effective_price_formula'),
    priceDriftStatus: text('price_drift_status').default('unknown').notNull(),
    description: text('description'),
    smokeTested: integer('smoke_tested', { mode: 'boolean' })
      .default(false)
      .notNull(),
    featured: integer('featured', { mode: 'boolean' }).default(false).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_listing_model_group').on(table.modelId, table.groupId),
    index('idx_listing_group').on(table.groupId),
    index('idx_listing_status').on(table.statusId),
  ]
);

export const catalogPriceSyncRun = table(
  'catalog_price_sync_run',
  {
    id: text('id').primaryKey(),
    operatorUserId: text('operator_user_id'),
    status: text('status').default('running').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    remoteModelCount: integer('remote_model_count').default(0).notNull(),
    matchedModelCount: integer('matched_model_count').default(0).notNull(),
    driftCount: integer('drift_count').default(0).notNull(),
    fixedPriceCount: integer('fixed_price_count').default(0).notNull(),
    missingGroupCount: integer('missing_group_count').default(0).notNull(),
    sourceFingerprint: text('source_fingerprint'),
    errorMessage: text('error_message'),
    reportJson: text('report_json'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('idx_catalog_price_sync_run_status').on(table.status),
    index('idx_catalog_price_sync_run_started').on(table.startedAt),
  ]
);

export const newApiUserBinding = table(
  'newapi_user_binding',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    newapiUserId: text('newapi_user_id').notNull(),
    status: text('status').notNull(), // pending, provisioning, active, username_sync_pending, username_sync_failed, conflict_requires_review, disabled
    newapiUsername: text('newapi_username'),
    targetNewapiUsername: text('target_newapi_username'),
    lastSyncErrorCode: text('last_sync_error_code'),
    lastSyncError: text('last_sync_error'),
    lastSyncAction: text('last_sync_action'),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
    lastSyncAttemptedAt: integer('last_sync_attempted_at', {
      mode: 'timestamp_ms',
    }),
    conflictNewapiUserId: text('conflict_newapi_user_id'),
    newapiPasswordEnc: text('newapi_password_enc'),
    newapiAccessTokenEnc: text('newapi_access_token_enc'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_newapi_user_binding_portal_user').on(table.portalUserId),
    uniqueIndex('idx_newapi_user_binding_newapi_user').on(table.newapiUserId),
    index('idx_newapi_user_binding_status').on(table.status),
    index('idx_newapi_user_binding_target_username').on(
      table.targetNewapiUsername
    ),
    index('idx_newapi_user_binding_sync_error_code').on(
      table.lastSyncErrorCode
    ),
  ]
);

export const newApiKeyBinding = table(
  'newapi_key_binding',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    newapiUserId: text('newapi_user_id').notNull(),
    newapiKeyId: text('newapi_key_id').notNull(),
    keyMasked: text('key_masked').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull(),
    allowedModels: text('allowed_models').notNull().default('[]'),
    groupId: text('group_id').references(() => catalogGroup.id, {
      onDelete: 'set null',
    }),
    newapiGroup: text('newapi_group').default('').notNull(),
    quotaLimit: integer('quota_limit'),
    ipAllowlist: text('ip_allowlist').notNull().default('[]'),
    idempotencyKey: text('idempotency_key').notNull(),
    lastRemoteError: text('last_remote_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('idx_newapi_key_binding_portal_status').on(
      table.portalUserId,
      table.status
    ),
    uniqueIndex('idx_newapi_key_binding_remote_key').on(table.newapiKeyId),
    uniqueIndex('idx_newapi_key_binding_idempotency').on(table.idempotencyKey),
    uniqueIndex('idx_newapi_key_binding_user_display_name_active')
      .on(table.portalUserId, table.displayName)
      .where(sql`${table.status} <> 'deleted'`),
    index('idx_newapi_key_binding_group').on(table.groupId),
  ]
);

export const usageSnapshot = table(
  'usage_snapshot',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    newapiUserId: text('newapi_user_id').notNull(),
    range: text('range').notNull(), // 7d, 30d, month
    balanceUsd: integer('balance_usd'),
    quotaRemaining: integer('quota_remaining'),
    requestCount: integer('request_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    spendUsd: integer('spend_usd'),
    byModel: text('by_model').notNull().default('[]'),
    status: text('status').notNull(), // ready, empty, syncing, stale, failed
    errorMessage: text('error_message'),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_usage_snapshot_user_range').on(
      table.portalUserId,
      table.range
    ),
    index('idx_usage_snapshot_status').on(table.status),
  ]
);

export const usageLogSnapshot = table(
  'usage_log_snapshot',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    newapiRequestId: text('newapi_request_id'),
    keyMasked: text('key_masked').notNull(),
    modelId: text('model_id').notNull(),
    status: text('status').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheTokens: integer('cache_tokens'),
    cacheRatio: real('cache_ratio'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    cacheCreationRatio: real('cache_creation_ratio'),
    cacheCreationTokens5m: integer('cache_creation_tokens_5m'),
    cacheCreationRatio5m: real('cache_creation_ratio_5m'),
    cacheCreationTokens1h: integer('cache_creation_tokens_1h'),
    cacheCreationRatio1h: real('cache_creation_ratio_1h'),
    usageSemantic: text('usage_semantic'),
    spendUsd: integer('spend_usd'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    syncedAt: integer('synced_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
  },
  (table) => [
    index('idx_usage_log_snapshot_user_created').on(
      table.portalUserId,
      table.createdAt
    ),
    index('idx_usage_log_snapshot_model').on(table.modelId),
    uniqueIndex('idx_usage_log_snapshot_remote_request').on(
      table.newapiRequestId
    ),
  ]
);

export const apipoolLedgerEntry = table(
  'apipool_ledger_entry',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    operatorUserId: text('operator_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    newapiUserId: text('newapi_user_id').notNull(),
    newapiChangeId: text('newapi_change_id'),
    // 「远端已尝试」的持久化标记，写在任何远端副作用之前。
    // changeId 为空只证明码值没落库，不能证明远端没创建过兑换码——
    // 只有该标记为 null 才是「远端什么都没发生」的证据（自动重试的前提）。
    remoteAttemptAt: integer('remote_attempt_at', { mode: 'timestamp_ms' }),
    orderNo: text('order_no'),
    idempotencyKey: text('idempotency_key'),
    amountUsd: integer('amount_usd').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull(),
    executor: text('executor').notNull(),
    reason: text('reason').notNull(),
    rollbackStatus: text('rollback_status').notNull().default('not_required'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('idx_apipool_ledger_portal_created').on(
      table.portalUserId,
      table.createdAt
    ),
    index('idx_apipool_ledger_status').on(table.status),
    index('idx_apipool_ledger_remote_attempt').on(table.remoteAttemptAt),
    uniqueIndex('idx_apipool_ledger_newapi_change').on(table.newapiChangeId),
    uniqueIndex('idx_apipool_ledger_order_no').on(table.orderNo),
    uniqueIndex('idx_apipool_ledger_idempotency').on(table.idempotencyKey),
  ]
);

export const newApiBridgeAuditLog = table(
  'newapi_bridge_audit_log',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id'),
    operatorUserId: text('operator_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key'),
    requestBody: text('request_body'),
    responseBody: text('response_body'),
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
  },
  (table) => [
    index('idx_newapi_bridge_audit_portal_created').on(
      table.portalUserId,
      table.createdAt
    ),
    index('idx_newapi_bridge_audit_action_status').on(
      table.action,
      table.status
    ),
  ]
);

// RBAC Tables
export const role = table(
  'role',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(), // admin, editor, viewer
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [
    // Query active roles
    index('idx_role_status').on(table.status),
  ]
);

export const permission = table(
  'permission',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(), // admin.users.read, admin.posts.write
    resource: text('resource').notNull(), // users, posts, categories
    action: text('action').notNull(), // read, write, delete
    title: text('title').notNull(),
    description: text('description'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // Composite: Query permissions by resource and action
    // Can also be used for: WHERE resource = ? (left-prefix)
    index('idx_permission_resource_action').on(table.resource, table.action),
  ]
);

export const rolePermission = table(
  'role_permission',
  {
    id: text('id').primaryKey(),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permission.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    // Composite: Query permissions for a role
    // Can also be used for: WHERE roleId = ? (left-prefix)
    index('idx_role_permission_role_permission').on(
      table.roleId,
      table.permissionId
    ),
  ]
);

export const userRole = table(
  'user_role',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    // Composite: Query user's active roles (most critical for auth)
    // Can also be used for: WHERE userId = ? (left-prefix)
    index('idx_user_role_user_expires').on(table.userId, table.expiresAt),
  ]
);

export const aiTask = table(
  'ai_task',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mediaType: text('media_type').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    options: text('options'),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    taskId: text('task_id'), // provider task id
    taskInfo: text('task_info'), // provider task info
    taskResult: text('task_result'), // provider task result
    costCredits: integer('cost_credits').notNull().default(0),
    scene: text('scene').notNull().default(''),
    creditId: text('credit_id'), // credit consumption record id
  },
  (table) => [
    // Composite: Query user's AI tasks by status
    // Can also be used for: WHERE userId = ? (left-prefix)
    index('idx_ai_task_user_media_type').on(table.userId, table.mediaType),
    // Composite: Query user's AI tasks by media type and provider
    // Can also be used for: WHERE mediaType = ? AND provider = ? (left-prefix)
    index('idx_ai_task_media_type_status').on(table.mediaType, table.status),
  ]
);

export const chat = table(
  'chat',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    title: text('title').notNull().default(''),
    parts: text('parts').notNull(),
    metadata: text('metadata'),
    content: text('content'),
  },
  (table) => [index('idx_chat_user_status').on(table.userId, table.status)]
);

export const chatMessage = table(
  'chat_message',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
    role: text('role').notNull(),
    parts: text('parts').notNull(),
    metadata: text('metadata'),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
  },
  (table) => [
    index('idx_chat_message_chat_id').on(table.chatId, table.status),
    index('idx_chat_message_user_id').on(table.userId, table.status),
  ]
);

// ---------------- Portal Gateway v1（portal-newapi-routing-billing-decoupling，设计 §3） ----------------

export const portalApiKey = table(
  'portal_api_key',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => catalogGroup.id),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    status: text('status').notNull().default('active'),
    name: text('name').notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    disabledAt: integer('disabled_at', { mode: 'timestamp_ms' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    revokedReason: text('revoked_reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_portal_api_key_hash').on(table.keyHash),
    index('idx_portal_api_key_user_status').on(table.userId, table.status),
    uniqueIndex('uniq_portal_api_key_user_name_live')
      .on(table.userId, table.name)
      .where(sql`${table.status} != 'deleted'`),
  ]
);

export const modelRoute = table(
  'model_route',
  {
    id: text('id').primaryKey(),
    portalGroupId: text('portal_group_id')
      .notNull()
      .references(() => catalogGroup.id),
    portalModelId: text('portal_model_id').notNull(),
    newapiGroup: text('newapi_group').notNull(),
    newapiModelId: text('newapi_model_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('active'),
    publishedBy: text('published_by').notNull(),
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_model_route_active')
      .on(table.portalGroupId, table.portalModelId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('uniq_model_route_version').on(
      table.portalGroupId,
      table.portalModelId,
      table.version
    ),
  ]
);

export const modelPriceVersion = table(
  'model_price_version',
  {
    id: text('id').primaryKey(),
    portalGroupId: text('portal_group_id')
      .notNull()
      .references(() => catalogGroup.id),
    portalModelId: text('portal_model_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('active'),
    inputMicroUsdPerM: integer('input_micro_usd_per_m').notNull(),
    cachedInputMicroUsdPerM: integer('cached_input_micro_usd_per_m').notNull(),
    cacheWrite5mMicroUsdPerM: integer(
      'cache_write_5m_micro_usd_per_m'
    ).notNull(),
    cacheWrite1hMicroUsdPerM: integer(
      'cache_write_1h_micro_usd_per_m'
    ).notNull(),
    outputMicroUsdPerM: integer('output_micro_usd_per_m').notNull(),
    newapiRefInputMicroUsdPerM: integer('newapi_ref_input_micro_usd_per_m'),
    newapiRefOutputMicroUsdPerM: integer('newapi_ref_output_micro_usd_per_m'),
    newapiRefCachedInputMicroUsdPerM: integer(
      'newapi_ref_cached_input_micro_usd_per_m'
    ),
    newapiRefCacheWrite5mMicroUsdPerM: integer(
      'newapi_ref_cache_write_5m_micro_usd_per_m'
    ),
    newapiRefCacheWrite1hMicroUsdPerM: integer(
      'newapi_ref_cache_write_1h_micro_usd_per_m'
    ),
    refNewapiGroup: text('ref_newapi_group'),
    sourceNote: text('source_note'),
    publishedBy: text('published_by').notNull(),
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_model_price_version_active')
      .on(table.portalGroupId, table.portalModelId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('uniq_model_price_version_version').on(
      table.portalGroupId,
      table.portalModelId,
      table.version
    ),
  ]
);

export const runtimeCredential = table(
  'runtime_credential',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    newapiGroup: text('newapi_group').notNull(),
    newapiUserId: text('newapi_user_id'),
    remoteName: text('remote_name').notNull(),
    newapiTokenId: text('newapi_token_id'),
    tokenEnc: text('token_enc'),
    keyMasked: text('key_masked'),
    status: text('status').notNull().default('pending'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_runtime_credential_scope').on(
      table.portalUserId,
      table.newapiGroup
    ),
    index('idx_runtime_credential_user_status').on(
      table.portalUserId,
      table.status
    ),
    index('idx_runtime_credential_status').on(table.status),
  ]
);

export const walletAccount = table('wallet_account', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id),
  balanceMicroUsd: integer('balance_micro_usd').notNull().default(0),
  riskLimitOverride: integer('risk_limit_override'),
  frozenAt: integer('frozen_at', { mode: 'timestamp_ms' }),
  freezeReason: text('freeze_reason'),
  frozenBy: text('frozen_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sqliteNowMs)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sqliteNowMs)
    .$onUpdate(() => new Date())
    .notNull(),
});

export const walletLedger = table(
  'wallet_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    entryType: text('entry_type').notNull(),
    signedAmountMicroUsd: integer('signed_amount_micro_usd').notNull(),
    balanceAfterMicroUsd: integer('balance_after_micro_usd').notNull(),
    requestLedgerId: text('request_ledger_id'),
    orderNo: text('order_no'),
    idempotencyKey: text('idempotency_key'),
    operatorUserId: text('operator_user_id'),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_wallet_ledger_request_charge')
      .on(table.requestLedgerId)
      .where(sql`${table.entryType} = 'request_charge'`),
    uniqueIndex('uniq_wallet_ledger_recharge_order')
      .on(table.orderNo)
      .where(sql`${table.entryType} = 'recharge'`),
    uniqueIndex('uniq_wallet_ledger_idempotency').on(table.idempotencyKey),
    index('idx_wallet_ledger_user_created').on(table.userId, table.createdAt),
    check('ck_wallet_ledger_nonzero', sql`${table.signedAmountMicroUsd} != 0`),
  ]
);

export const requestLedger = table(
  'request_ledger',
  {
    id: text('id').primaryKey(),
    newapiRequestId: text('newapi_request_id'),
    userId: text('user_id').notNull(),
    portalKeyId: text('portal_key_id').notNull(),
    portalGroupId: text('portal_group_id').notNull(),
    portalModelId: text('portal_model_id').notNull(),
    newapiGroup: text('newapi_group').notNull(),
    newapiModelId: text('newapi_model_id').notNull(),
    credentialId: text('credential_id').notNull(),
    routeVersion: integer('route_version').notNull(),
    priceVersionId: text('price_version_id').notNull(),
    endpoint: text('endpoint').notNull(),
    isStream: integer('is_stream', { mode: 'boolean' })
      .notNull()
      .default(false),
    httpStatus: integer('http_status'),
    errorCode: text('error_code'),
    streamAborted: integer('stream_aborted', { mode: 'boolean' }),
    status: text('status').notNull().default('open'),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    respondedAt: integer('responded_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    settledAt: integer('settled_at', { mode: 'timestamp_ms' }),
    uncachedInputTokens: integer('uncached_input_tokens'),
    cachedReadTokens: integer('cached_read_tokens'),
    cacheWrite5mTokens: integer('cache_write_5m_tokens'),
    cacheWrite1hTokens: integer('cache_write_1h_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    usageSource: text('usage_source'),
    chargedMicroUsd: integer('charged_micro_usd'),
    backfillAttempts: integer('backfill_attempts').notNull().default(0),
    nextBackfillAt: integer('next_backfill_at', { mode: 'timestamp_ms' }),
    lastBackfillError: text('last_backfill_error'),
    newapiQuota: integer('newapi_quota'),
    newapiPromptTokens: integer('newapi_prompt_tokens'),
    newapiCompletionTokens: integer('newapi_completion_tokens'),
    newapiTokenName: text('newapi_token_name'),
    reconcileStatus: text('reconcile_status').notNull().default('pending'),
    reconciledAt: integer('reconciled_at', { mode: 'timestamp_ms' }),
    reconcileNote: text('reconcile_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_request_ledger_newapi_request').on(table.newapiRequestId),
    index('idx_request_ledger_risk')
      .on(table.userId)
      .where(sql`${table.status} IN ('open','pending_backfill')`),
    index('idx_request_ledger_backfill').on(table.status, table.nextBackfillAt),
    index('idx_request_ledger_user_created').on(table.userId, table.createdAt),
    index('idx_request_ledger_reconcile').on(table.reconcileStatus),
    check(
      'ck_request_ledger_settled',
      sql`${table.status} != 'settled' OR (${table.newapiRequestId} IS NOT NULL AND ${table.chargedMicroUsd} IS NOT NULL)`
    ),
  ]
);

export const portalAdminAuditLog = table(
  'portal_admin_audit_log',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(),
    operatorUserId: text('operator_user_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
  },
  (table) => [
    index('idx_portal_admin_audit_action_created').on(
      table.action,
      table.createdAt
    ),
    index('idx_portal_admin_audit_target').on(table.targetType, table.targetId),
  ]
);

export const credentialRetirement = table(
  'credential_retirement',
  {
    id: text('id').primaryKey(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => runtimeCredential.id),
    newapiTokenId: text('newapi_token_id').notNull(),
    reason: text('reason').notNull(),
    disabledAt: integer('disabled_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
  },
  (table) => [index('idx_credential_retirement_pending').on(table.disabledAt)]
);

export const gatewayJobLock = table('gateway_job_lock', {
  id: text('id').primaryKey(),
  holderId: text('holder_id'),
  heartbeatAt: integer('heartbeat_at', { mode: 'timestamp_ms' }),
  acquiredAt: integer('acquired_at', { mode: 'timestamp_ms' }),
  reconcileWatermarkAt: integer('reconcile_watermark_at', {
    mode: 'timestamp_ms',
  }),
});

export const reconcileOrphanObservation = table(
  'reconcile_orphan_observation',
  {
    id: text('id').primaryKey(),
    newapiRequestId: text('newapi_request_id').notNull(),
    portalUserId: text('portal_user_id'),
    newapiGroup: text('newapi_group'),
    newapiModelId: text('newapi_model_id'),
    credentialId: text('credential_id'),
    tokenName: text('token_name').notNull(),
    newapiQuota: integer('newapi_quota'),
    newapiPromptTokens: integer('newapi_prompt_tokens'),
    newapiCompletionTokens: integer('newapi_completion_tokens'),
    logCreatedAt: integer('log_created_at', { mode: 'timestamp_ms' }),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_orphan_observation_request').on(table.newapiRequestId),
    index('idx_orphan_observation_user').on(table.portalUserId),
    index('idx_orphan_observation_open').on(table.resolvedAt),
  ]
);
