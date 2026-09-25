#!/usr/bin/env bash
# AC_SECURITY_04 dynamic secret scan: build what would ship and scan it. Nothing is deployed.
# Used by CI and scripts/verify.sh; docs/Deployment_Runbook.md §3.2.
#
#   scripts/scan-release-artifacts.sh [<out-dir>]   # default: a temporary directory, removed after
#
# 1. Release-shaped builds: the web portal, the Worker bundle (wrangler dry run, production env),
#    the Expo web export and the public app config that native builds embed (expo-constants), with
#    every public build variable (VITE_*, EXPO_PUBLIC_*) set to an obviously fake value of the
#    documented public shape. Real release values never exist in CI; these make the bundles carry
#    the variables the way a release build does, so the scan's public-value allowlist is exercised
#    on real output. The app config is rendered twice under the release rules of app.config.ts
#    (EAS_BUILD_PROFILE, EAS_PROJECT_ID, EXPO_OWNER as EAS Build sets them): once for the
#    Google Play / App Store `production` profile and once for the Amazon Appstore
#    `production-amazon` profile (EXPO_PUBLIC_ANDROID_STORE=amazon, an `amzn_` key placeholder;
#    AMZ-21), so a release-rule regression in app.config.ts fails here too. The scan must pass.
# 2. Negative control: the web portal and the app config again, with a fake service-role key, a
#    fake Supabase secret key, a fake Stripe test-mode secret key and a fake database URL with its
#    password in public build variables. The scan must fail and name each planted detector. If a
#    build stops embedding these variables where the scan looks, or the scan stops seeing one of
#    them (LRD-3: test-mode keys and database URLs once passed unseen), this fails. The control
#    renders the app config under the development rules on purpose: a release profile refuses a
#    non-https portal URL before anything is embedded, and the control must prove the scan itself
#    sees the planted value.
#
# The fake values are assembled at run time, so no credential-shaped literal is tracked.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -gt 0 ]; then
  out="$1"
  mkdir -p "$out"
else
  out=$(mktemp -d)
  trap 'rm -rf "$out"' EXIT
fi
out=$(cd "$out" && pwd)

eval "$(node --input-type=module -e '
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (role) =>
  [b64({ alg: "HS256", typ: "JWT" }), b64({ iss: "supabase", ref: "fakeprojectref00000a", role }), "Zm".repeat(20)].join(".");
const values = {
  FAKE_ANON_KEY: jwt("anon"),
  FAKE_SERVICE_ROLE_KEY: jwt(["service", "role"].join("_")),
  FAKE_SECRET_KEY: ["sb", "secret", "FAKEfakeFAKEfake0000"].join("_"),
  FAKE_STRIPE_TEST_KEY: ["sk", "test", "FAKEfakeFAKEfake0000"].join("_"),
  FAKE_DATABASE_URL: ["postgres://postgres:", "Fake", "Passw0rd", "0000", "@db.fakeprojectref00000a.supabase.co:5432/postgres"].join(""),
  FAKE_IOS_KEY: ["appl", "FAKEfakeFAKEfake00"].join("_"),
  FAKE_ANDROID_KEY: ["goog", "FAKEfakeFAKEfake00"].join("_"),
  FAKE_AMAZON_KEY: ["amzn", "FAKEfakeFAKEfake00"].join("_"),
  FAKE_EAS_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
};
for (const [name, value] of Object.entries(values)) console.log(`${name}=${value}`);
')"

public_env=(
  VITE_API_BASE_URL=https://api.pencillift.invalid
  VITE_SUPABASE_URL=https://fakeprojectref00000a.supabase.invalid
  VITE_SUPABASE_PUBLISHABLE_KEY="$FAKE_ANON_KEY"
  EXPO_PUBLIC_API_BASE_URL=https://api.pencillift.invalid
  EXPO_PUBLIC_SUPABASE_URL=https://fakeprojectref00000a.supabase.invalid
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$FAKE_ANON_KEY"
  EXPO_PUBLIC_PORTAL_URL=https://app.pencillift.invalid
  EXPO_PUBLIC_REVENUECAT_IOS_KEY="$FAKE_IOS_KEY"
  EXPO_PUBLIC_REVENUECAT_ANDROID_KEY="$FAKE_ANDROID_KEY"
  EXPO_NO_TELEMETRY=1
  WRANGLER_SEND_METRICS=false
)
# The variables EAS Build sets, plus the linkage every release profile requires (app.config.ts).
release_env=(
  "${public_env[@]}"
  EAS_PROJECT_ID="$FAKE_EAS_PROJECT_ID"
  EXPO_OWNER=fake-owner
  EAS_BUILD_PROFILE=production
)
amazon_env=(
  "${release_env[@]}"
  EAS_BUILD_PROFILE=production-amazon
  EAS_BUILD_PLATFORM=android
  EXPO_PUBLIC_ANDROID_STORE=amazon
  EXPO_PUBLIC_REVENUECAT_AMAZON_KEY="$FAKE_AMAZON_KEY"
)
leaked_env=(
  "${public_env[@]}"
  VITE_SUPABASE_PUBLISHABLE_KEY="$FAKE_SERVICE_ROLE_KEY"
  VITE_API_BASE_URL="$FAKE_STRIPE_TEST_KEY"
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$FAKE_SECRET_KEY"
  EXPO_PUBLIC_PORTAL_URL="$FAKE_DATABASE_URL"
)

build_web() { # <out> <env...>
  local dest="$1"
  shift
  env "$@" pnpm -s --filter @pencillift/web exec vite build --outDir "$dest" --emptyOutDir --logLevel warn
}
app_config() { # <out> <env...>  the public config expo-constants embeds in native builds
  local dest="$1"
  shift
  mkdir -p "$dest"
  (cd apps/mobile && env "$@" npx expo config --type public --json) >"$dest/app.config.json"
}

echo "▶ build web portal"
build_web "$out/web" "${public_env[@]}"
echo "▶ build Worker bundle (dry run, nothing deployed)"
(cd apps/api && env "${public_env[@]}" npx wrangler deploy --dry-run --env production --outdir "$out/worker")
echo "▶ export mobile app for web"
(cd apps/mobile && env "${public_env[@]}" npx expo export --platform web --output-dir "$out/expo-web")
echo "▶ public app config (embedded in native builds; production profile)"
app_config "$out/app-config" "${release_env[@]}"
echo "▶ public app config (Amazon Appstore production-amazon profile)"
app_config "$out/app-config-amazon" "${amazon_env[@]}"
# The Amazon render must be the Amazon build, or the profile rules were not exercised.
grep -Eq '"androidStore": ?"amazon"' "$out/app-config-amazon/app.config.json" ||
  { echo "✗ the Amazon app config did not render as an Amazon build" >&2; exit 1; }
grep -Eq '"androidStore": ?"play"' "$out/app-config/app.config.json" ||
  { echo "✗ the production app config did not render as a Google Play build" >&2; exit 1; }
echo "▶ artifact secret scan"
node scripts/scan-secrets.mjs --artifacts "$out/web" "$out/worker" "$out/expo-web" "$out/app-config" "$out/app-config-amazon"

echo "▶ negative control: a secret in a public build variable must fail the scan"
build_web "$out/control/web" "${leaked_env[@]}"
app_config "$out/control/app-config" "${leaked_env[@]}"
control() { # <dir> <detector>...  the scan must fail and name every planted detector
  local dir="$1"
  shift
  local status=0 output
  output=$(node scripts/scan-secrets.mjs --artifacts "$dir" 2>&1) || status=$?
  printf '%s\n' "$output"
  if [ "$status" != 1 ]; then
    echo "✗ negative control: the planted keys in $dir were not found (scan exit $status)" >&2
    exit 1
  fi
  local detector
  for detector in "$@"; do
    if ! grep -qF ": $detector" <<<"$output"; then
      echo "✗ negative control: the planted $detector in $dir was not found" >&2
      exit 1
    fi
  done
}
control "$out/control/web" "service-role JWT" "Stripe test secret"
control "$out/control/app-config" "Supabase secret key" "database URL with password"
echo "✓ release artifact scan passed; the planted keys were found (expected findings above)"
