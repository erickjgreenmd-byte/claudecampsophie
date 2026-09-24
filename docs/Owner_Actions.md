# Owner actions (spec E1, Owner_Actions.md at the package root)

Only concrete external actions that the builder cannot perform, each with the preparation already done.
Nothing here asks to reconfirm approved scope (prices, P17 promotions, one school per family and
full-price-only donations are settled).

| # | Action needed from the owner | Why the builder cannot do it | Prepared by the builder | Unblocks |
|---|---|---|---|---|
| 1 | **Decide iOS prices for 2–4 children.** Apple's USD price points cannot represent $49.98, $59.97, $69.96 (nearest: $49.49/$49.99/$50.00, $59.99/$60.00, $69.99/$70.00). Options: (a) accept nearest points on iOS only, (b) sell 2–4 child plans on iOS at nearest points and keep exact totals on Google/web, (c) change the approved totals everywhere. | Spec forbids silent rounding; it's a pricing decision (Owner_Actions "Exact paid prices") | `docs/Provider_Capability_Matrix.md` §1; code blocks any tier whose store price ≠ approved price. **Knock-on effect:** the approved donation rule requires a charge exactly equal to the approved tier price, so with (a) or (b) no 2–4-child iOS family would ever earn the $1 school donation unless the owner also defines the iOS store price as that channel's regular price | AC_CAPACITY_02, AC_CAPACITY_11, AC_PROMO_11, iOS store products |
| 2 | **Decide how iOS/Google monthly promos behave when a percentage isn't representable.** Apple offers use price points, not percentages, and one redemption per customer per offer. | Commercial promise vs store rules | Matrix §2–3: per-channel `unsupported` status, smallest compliant alternatives listed | AC_PROMO_06/07 on native channels |
| 3 | Give the build environment access to the **existing Supabase staging project** (CLI login or MCP with project scope). | No credentials exist in this environment | Migrations + RLS tests run against local PG16; `supabase/` ready for `supabase db push` | AC_CONN_01/02/06, deployed backend |
| 4 | Give access to **RevenueCat** (project, iOS/Android apps) and **App Store Connect / Play Console** product setup. | No access | Product-to-slot mapping schema, webhook handler, reconciliation logic | AC_BILLING_*, AC_CONN_03/04/05 |
| 5 | Give access to **Expo/EAS** (project + `EXPO_TOKEN` for CI) and Apple/Google signing. | No access; native builds impossible here | App config and EAS profiles in `apps/mobile` | AC_DEPLOY_02, M5 |
| 6 | Provide **OpenAI API project access** from an environment whose network policy allows api.openai.com, and **documented ZDR approval** for under-13 data. | Egress to api.openai.com is blocked here; ZDR is an account approval | Server-only adapter, ZDR gate that fails closed, usage metering | AC_ACCESS_03, AC_GRADING_11, measured costs |
| 7 | **Select and contract a verifiable-parental-consent provider.** | Commercial/legal choice | Consent adapter interface + labeled development mock that production rejects | AC_ACCESS_01/02, production child data |
| 8 | Provide a **Cloudflare account** (or approve an alternative runtime) and DNS access for PencilLift.com at deployment time. | No access | Workers API, cron/queue handlers, runbook | AC_CONN_02, AC_DEPLOY_04/06 |
| 9 | Supply an **authorized monthly spending cap** for AI (and campaign budget caps per promo template). | Spec forbids inventing the owner's cap | Spend ceiling + 50/80/100% alerts require an explicit budget and refuse to run without one | AC_FIN_09, AC_FIN_10 |
| 10 | Arrange **independent security/privacy review** and **educator review** of AI teaching. | Must be independent humans (spec V1) | Threat model, test evidence, evaluation harness design | AC_GRADING_12, release |
| 11 | Store accounts: Apple Developer Program / Google Play registration, agreements, tax/banking, D-U-N-S if organization. | Account-holder steps | Store metadata drafts later | AC_DEPLOY_05, M6–M7 |
| 12 | School payout: recipient verification details and a transfer method (kept disabled until provided). | No live banking details may be invented | Payout batches, reconciliation, disabled transfers | AC_PROMO_12 live payouts |

Account sign-up alone does not complete a row; each closes only with recorded evidence in `docs/Connections.md`.
