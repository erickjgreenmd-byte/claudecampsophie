# Owner setup and launch dependencies

The builder should complete code, local testing and sandbox adapters while these items are prepared. This is a list of concrete dependencies, not a request to buy every service immediately.

## Accounts and ownership

| Item | Owner supplies | Builder prepares |
|---|---|---|
| Domain | Registrar access/DNS authorization for the purchased PencilLift.com | Exact DNS/TLS instructions; no credentials in source |
| Legal owner | Entity/seller name, business contact, actual support mailbox, launch market | Configuration and public support/privacy/terms/deletion pages |
| Apple | Developer account, $99/year membership, organization verification if applicable, contracts/tax/banking | Bundle ID proposal, signing procedure, TestFlight build, store listing and IAP setup guide |
| Google | Play Console account, $25 registration, verification, contracts/tax/banking | Android package ID, signing/AAB, testing track and products guide |
| OpenAI | Paid API project, spending limits, model access, approved ZDR configuration for applicable child data | Server adapter, model evaluation, stateless workflow, operational launch gate |
| Consent | Approved verifiable-parental-consent method/provider, contractual pricing and reviewed child-data notices | Real provider adapter, webhook validation, pending/revoked/error states; dev-only mock |
| Supabase | Organization/projects and billing | Schema, RLS, auth/storage config, backups/restore and separation of environments |
| Hosting | API/queue/web hosting account and scoped deployment access | Deploy configuration, CI, rollback, queue/cron setup |
| Expo/EAS | Organization/project and signing access | Reproducible native builds and submission configuration |
| RevenueCat | Project, store connections and scoped credentials | SDK, verified entitlements, sandbox purchase/restore and lifecycle webhooks |
| Email/push | Sending-domain verification; Apple/FCM push setup | Transactional templates, receipts/status tracking and opt-outs |
| Catalog/Amazon | Vetted products; specific Amazon property/mobile eligibility and approved linking-tool access, if obtainable | Full affiliate adapter, disclosures, free parent access, safe plain-link/education fallback and honest blocked-live state |
| Sponsors/ads | Signed sponsor terms, licensed assets and actual platform/provider eligibility | Parent-only reviewed cards, campaign admin, reporting/caps/kill switches and reconciled revenue |

Use the owner's legal company for store accounts when appropriate; do not select an organization account solely to bypass a personal-account testing requirement. Buying a domain does not reserve the app-store name or clear trademark rights. App-store review and child privacy review remain necessary.

## Business decisions with sensible defaults

- Initial US/English launch, K-8 coverage; later expansion is configurable.
- One parent/family account; initial configurable plans for 1-4 paid child slots. $39.99/month for the first child, plus $9.99/month for each additional child: $39.99 / $49.98 / $59.97 / $69.96. Verify exact US store price points and product-to-slot mapping before activation; do not silently round totals.
- Keep AI central. The base/additional-child price is approved; profitability and final advertised usage limits require pilot validation. Test fresh daily AI practice as well as the original eight-custom-set scenario, with zero, projected and realized commercial revenue.
- Prototype allowance for validation: 40 homework pages/month per paid child, five daily questions, eight Thursday review questions per enabled subject and bounded original AI coaching. Each added child receives their own allowance and learning profile. Publish final limits only after workload validation; show usage clearly.
- Six-digit adult unlock PIN plus authenticated parent recovery; consent is a separate verified flow.
- Thursday 4 p.m. family-local release; all days offer daily challenges; parents control holidays and test dates.
- Rewards are fulfilled by parents outside the app. Money is a label/goal, not a held balance or payout service.
- Ads are parent-only approved sponsor placements initially. Build Amazon affiliate support, but live eligibility for this child-directed product is unresolved and must not be presumed. No learning points for advertisements, affiliate clicks or purchases.
- Do not count unsigned sponsor offers or hypothetical affiliate sales as operating income. Keep AI/help available when commercial services are off.
- Parent-approved store upgrades activate verified child slots; downgrades preserve history and follow the store effective date. A draft/deleted profile does not automatically change billing.
- Optional web subscription billing is disabled until Stripe setup and current store-specific rules are reviewed.

## Required external reviews before public release

Have a qualified reviewer assess child privacy/consent, retention, vendor contracts, app-store category and SDK/data disclosures, and the brand. No document in this package is a completed legal opinion, trademark clearance, COPPA certification or store approval. Provider quotes may add costs not covered by advertised public prices, especially consent/ZDR arrangements. Do not launch an under-13 workflow with ordinary data retention as a substitute for obtaining the required setup.

The final submission checklist should include active reviewer accounts with synthetic examples, actual screenshots, complete subscription terms, support/deletion URLs, and evidence that all critical acceptance tests pass. Submission is an owner-controlled step after the reviewable builds are ready.
