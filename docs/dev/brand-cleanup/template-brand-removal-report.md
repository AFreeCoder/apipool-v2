# Template Brand Removal Report

Date: 2026-06-28

## Scope

This pass removes legacy template brand exposure from APIPool's public surface:

- Root social preview image.
- Header/footer logo and favicon assets.
- Unused public marketing screenshots, showcase images, background images, placeholder avatars, and technology logos from the original template.
- Public-facing copy and tests that named the old template brand directly.

## Changes

- Removed the default `public/preview.png` entirely until the logo and preview direction is finalized.
- Removed default `public/logo.png`, `public/favicon.ico`, `public/logo.svg`, `public/favicon.svg`, and `public/preview.svg`; APIPool now has no default shipped brand image unless explicitly configured.
- Updated metadata generation so Open Graph / Twitter image tags are omitted when no preview image is configured.
- Updated public shell, auth/docs/admin/error surfaces to treat logo images as optional and render text-only branding by default.
- Removed unused public directories:
  - `public/imgs/avatars`
  - `public/imgs/bg`
  - `public/imgs/cases`
  - `public/imgs/features`
  - `public/imgs/logos`
- Kept `public/imgs/icons` because payment provider UI still references Stripe, Creem, and PayPal icons.
- Changed the legacy social avatars block to render generated initials instead of deleted placeholder image files.
- Added `tests/public-content/brand-assets.test.ts` to guard against default placeholder brand images and removed template image directories returning.

## Remaining Intentional Exception

The repository root `LICENSE` file still contains the original template vendor's license text. That file is not part of the public Next.js site, and it should not be rewritten as a brand cleanup unless the legal/licensing position changes.

## Verification

- `pnpm exec prettier --check docs/06-payments-ledger.md docs/dev/brand-cleanup/template-brand-removal-report.md src/config/index.ts src/shared/lib/seo.ts src/features/apipool-ui/site-shell.tsx src/app/layout.tsx src/shared/blocks/common/brand-logo.tsx src/app/[locale]/(docs)/layout.config.tsx src/app/not-found.tsx src/shared/blocks/common/error-boundary.tsx src/app/[locale]/(admin)/layout.tsx src/shared/blocks/dashboard/sidebar-header.tsx src/core/auth/config.ts src/themes/default/blocks/social-avatars.tsx tests/public-content/brand-assets.test.ts tests/public-content/legacy-credit-api.test.ts tests/public-content/legacy-settings-redirects.test.ts tests/public-content/locale-copy.test.ts`
- `NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/public-content/brand-assets.test.ts tests/public-content/locale-copy.test.ts tests/public-content/legacy-credit-api.test.ts tests/public-content/legacy-settings-redirects.test.ts tests/public-content/indexing.test.ts tests/public-content/legacy-public-routes.test.ts tests/public-content/template-api-routes.test.ts`
- `pnpm exec eslint src/themes/default/blocks/social-avatars.tsx tests/public-content/brand-assets.test.ts tests/public-content/locale-copy.test.ts tests/public-content/legacy-credit-api.test.ts tests/public-content/legacy-settings-redirects.test.ts`
- `pnpm exec tsc --noEmit --pretty false`
- `pnpm build`
