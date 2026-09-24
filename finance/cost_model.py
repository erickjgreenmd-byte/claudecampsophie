"""PencilLift planning illustration. Standard library only; no network or billing.

Run: python3 finance/cost_model.py
Run built-in arithmetic checks: python3 finance/cost_model.py --check
Outputs cost_report.md and scenario_results.json in this directory.
All usage and nonvendor allowances are explicitly unmeasured.
"""
from pathlib import Path
from decimal import Decimal
import json
import sys

D = lambda value: Decimal(str(value))
ROOT = Path(__file__).resolve().parent

def price(children):
    if type(children) is not int or not 1 <= children <= 4:
        raise ValueError('Paid child capacity must be an integer from 1 through 4')
    return D(3999 + 999 * (children - 1)) / 100

def rc_fee(total, config):
    # Conservative equality interpretation of the public threshold; verify contract.
    return total * D(config['rate']) if total >= D(config['threshold_usd']) else D(0)

def ai_rows(children, scenario, config):
    n = D(children)
    s = config['workloads'][scenario]
    p, explanations, turns = [D(s[k]) for k in ['pages', 'explanations', 'followups']]
    sets = D(s['fresh_daily_sets'])
    weeks = D(52) / 12
    subjects = D(s['thursday_subjects'])
    # Bundle tokens scale with subject count; actual measurements must replace this assumption.
    thursday_scale = subjects / 4
    escalations = p * D(config['escalation_share'])
    semantic = (D(5) * sets + D(8) * subjects * weeks) * D(config['semantic_share'])
    rows = [
        ('Vision extraction', 'terra', n*p, 4000, 1200),
        ('Private grading', 'terra', n*p, 2500, 2000),
        ('Original explanations', 'astra', n*explanations, 1000, 1500),
        ('Follow-up coaching', 'astra', n*turns, 1200, 500),
        ('Fresh daily sets', 'astra', n*sets, 1000, 1500),
        ('Thursday bundles', 'astra', n*weeks, D(2500)*thursday_scale, D(4000)*thursday_scale),
        ('Homework verification', 'terra', n*p, 4000, 600),
        ('Explanation verification', 'terra', n*explanations, 2500, 500),
        ('Follow-up verification', 'terra', n*turns, 2000, 500),
        ('Daily-set verification', 'terra', n*sets, 3000, 600),
        ('Thursday verification', 'terra', n*weeks, D(6500)*thursday_scale, D(1000)*thursday_scale),
        ('Semantic practice checks', 'terra', n*semantic, 1200, 300),
        ('Semantic result verification', 'terra', n*semantic, 1800, 300),
        ('Difficult-page escalation', 'astra', n*escalations, 4000, 2000),
        ('Escalated result verification', 'terra', n*escalations, 6000, 700),
        ('Adult weekly summary', 'luna', weeks, 4000, 1000),
    ]
    result = []
    for stage, model, calls, tokens_in, tokens_out in rows:
        rate = config['model_rates'][model]
        cost = calls * (D(tokens_in)*D(rate['input_per_million']) + D(tokens_out)*D(rate['output_per_million'])) / D(1_000_000)
        result.append(dict(stage=stage, model=model, calls=calls, input_per_call=D(tokens_in), output_per_call=D(tokens_out), expected_usd=cost))
    return result

def scenario_result(families, children, workload, channel, config):
    if type(families) is not int or families <= 0:
        raise ValueError('Positive integer family count required')
    gross = price(children) * families
    expected = sum(row['expected_usd'] for row in ai_rows(children, workload, config)) * families
    reserve = expected * D(config['ai_contingency'])
    if channel in ('native15', 'native30'):
        channel_fee = gross * D('0.15' if channel == 'native15' else '0.30')
    elif channel == 'web':
        channel_fee = gross * (D(config['stripe']['processing_rate'])+D(config['stripe']['billing_rate'])) + families*D(config['stripe']['fixed_usd'])
    else:
        raise ValueError('Unknown channel')
    # Web illustration assumes subscriptions ARE tracked in RevenueCat. No link-out fees included.
    tracked_fee = rc_fee(gross, config['revenuecat'])
    refunds = gross * D(config['refund_allowance_rate'])
    support = D(config['support_per_family']) * families
    consent_allowance = D(config['consent_one_time_assumption']) / D(config['consent_allocation_months']) * families
    variable_other = D(config['other_variable_per_family']) * families
    other = refunds + support + consent_allowance + variable_other
    contribution = gross-channel_fee-tracked_fee-expected-other
    return dict(families=families, children=children, workload=workload, channel=channel,
        gross_usd=gross, expected_ai_usd=expected, ai_contingency_usd=reserve,
        channel_fee_usd=channel_fee, revenuecat_usd=tracked_fee,
        refund_allowance_usd=refunds, support_allowance_usd=support,
        consent_allocation_usd=consent_allowance, other_variable_allowance_usd=variable_other,
        contribution_before_fixed_usd=contribution,
        budgeted_contribution_before_fixed_usd=contribution-reserve,
        net_profit_usd=None, unpriced_costs_remain=True)

def mixed_result(families, workload, channel, config):
    mix = [D(x) for x in config['family_mix']]
    if sum(mix) != 1 or any(x < 0 for x in mix):
        raise ValueError('Family mix must be nonnegative and sum to one')
    # Calculate weighted per-family spend first, then apply the ONE account-level RC threshold.
    rows = [scenario_result(families, n, workload, channel, config) for n in range(1,5)]
    gross = sum(mix[i]*rows[i]['gross_usd'] for i in range(4))
    contribution = sum(mix[i]*(rows[i]['budgeted_contribution_before_fixed_usd']+rows[i]['revenuecat_usd']) for i in range(4)) - rc_fee(gross,config['revenuecat'])
    return dict(families=families, workload=workload, channel=channel, family_mix=mix,
        gross_usd=gross, budgeted_contribution_before_fixed_usd=contribution,
        net_profit_usd=None, unpriced_costs_remain=True)

def break_even(fixed, config):
    # Explicitly partial: two children, typical workload, native15 and no unpriced expenses.
    for n in range(1, 100001):
        if scenario_result(n,2,'typical','native15',config)['budgeted_contribution_before_fixed_usd'] >= fixed:
            return n
    return None

def money(x):
    return ('-' if x < 0 else '') + f'${abs(x):,.2f}'

def checks(c):
    assert [price(n) for n in range(1,5)] == list(map(D,['39.99','49.98','59.97','69.96']))
    assert rc_fee(D('2499.99'),c['revenuecat']) == 0
    assert rc_fee(D('2500'),c['revenuecat']) == D('25')
    assert rc_fee(D('3000'),c['revenuecat']) == D('30')
    r=scenario_result(1000,2,'typical','native15',c)
    assert r['channel_fee_usd'] == D('7497')  # Native excludes Stripe.
    w=scenario_result(1000,2,'typical','web',c)
    assert w['channel_fee_usd'] == D('2099.28')  # 3.6% plus 30c; excludes native fee.
    components=['channel_fee_usd','revenuecat_usd','expected_ai_usd','refund_allowance_usd','support_allowance_usd','consent_allocation_usd','other_variable_allowance_usd']
    assert abs(r['gross_usd']-sum(r[k] for k in components)-r['contribution_before_fixed_usd']) < D('0.000001')
    assert scenario_result(1000,4,'heavy','native15',c)['budgeted_contribution_before_fixed_usd'] < 0
    for n in range(1,5):
        assert scenario_result(10,n,'typical','native15',c)['revenuecat_usd']==0
    assert mixed_result(10,'typical','native15',c)['gross_usd']==D('499.8')
    for fixed in map(D,[500,2000,10000]):
        n=break_even(fixed,c)
        assert n and scenario_result(n,2,'typical','native15',c)['budgeted_contribution_before_fixed_usd']>=fixed
        assert n==1 or scenario_result(n-1,2,'typical','native15',c)['budgeted_contribution_before_fixed_usd']<fixed
    print('Passed: price tiers, account threshold, fee separation, arithmetic reconciliation, heavy loss, mix and break-even boundaries.')

def report(c):
    lines=['# PencilLift initial cost analysis', '', 'Checked September 18, 2026. USD. **Illustrative and unmeasured; not a quote, app benchmark, total launch budget or net-profit forecast.** The approved customer prices are fixed; usage, labor and allowances remain assumptions. No account-specific contract or balance was inspected.', '', '## Published prices to verify against the owner’s accounts', '', '| Service | Published starting rate / relevant charge | Limitation and source |','|---|---|---|']
    lines += [
        '| Claude Code | Pro $20/month monthly; Max starts at $100/month | Usage limits apply; API/extra usage can be separate. Development tool, not per-family runtime. [Claude](https://claude.com/pricing) |',
        '| Expo EAS | Starter $19/month with $45 build credit; Production $199/month with $225 build credit | Additional usage billed; choose from measured build/update needs, not the plan name. [Expo](https://expo.dev/pricing) |',
        '| Supabase | Pro $25/month; $10 organization compute credit | One Micro fits the credit; two Micro projects model $35/month before overages. Storage, egress, bigger compute and backup options add cost. [Supabase](https://supabase.com/pricing) |',
        '| Cloudflare Workers | Paid minimum $5/month | Requests/CPU, Queues and other services require their own usage calculation. [Workers](https://developers.cloudflare.com/workers/platform/pricing/) |',
        '| RevenueCat | Free up to stated $2,500 MTR threshold, then 1% of tracked revenue | Illustration charges the whole tracked total at $2,500 or above conservatively; confirm boundary/legacy terms. [RevenueCat](https://www.revenuecat.com/pricing) |',
        '| Apple membership | $99/year | Actual annual cash payment; $8.25/month allocation only in accrual view. [Apple](https://developer.apple.com/programs/enroll/) |',
        '| Google registration | $25 once | Do not repeat if already paid. [Google](https://support.google.com/googleplay/android-developer/answer/6112435) |',
        '| Native subscription fees | 15% baseline; 30% stress assumption | Apple reduced rate requires applicable eligibility/enrollment. Current US Google auto-renewing table is 10% service plus 5% Play Billing. Verify account, storefront and agreements. [Apple](https://developer.apple.com/app-store/small-business-program/), [Google](https://support.google.com/googleplay/android-developer/answer/112622) |',
        '| Optional US Stripe web billing | Domestic cards 2.9% + $0.30; Billing pay-as-you-go 0.7% | Model both when applicable; international, tax, disputes, external-link programs and other products may add fees. [Payments](https://stripe.com/en-us/pricing), [Billing](https://stripe.com/billing/pricing) |',
        '| Consent, child-data contract terms, security/privacy review and labor | Unknown | Obtain real scope/quotes. The allowances below do not establish actual provider fees or eligibility. |',
        '', 'OpenAI standard short-context input/output prices per million tokens: Astra **$10/$50**, Terra **$2/$12**, Luna **$0.20/$1.20**. Other billing modes can differ. The illustration uses no cache, Batch, fast-mode or regional discount/uplift; confirm the selected project configuration. [Official model pricing](https://developers.openai.com/api/docs/pricing)',
        '', '## Development and launch cash', '',
        'One selected month of Pro ($20), EAS Starter ($19), Supabase with two Micro projects ($35) and Workers ($5) is **$79 in listed base charges**. With Max starting at $100, the same subtotal starts at **$159**. If both store registrations are still unpaid, add $124: **$203 or $283** for those selected first-month items only. Existing paid items reduce incremental cash due; they do not remove future renewals.', '',
        '**These are not the cost of building or launching PencilLift.** Add development API usage, implementation/owner hours, consent setup, independent security and privacy review, educator testing, devices, email, monitoring, backups and any provider contract. Their actual cost is unresolved. Quote each line before presenting a total. A three-month development period would multiply recurring development charges by three but not repeat one-time Google registration. Domain purchase is already paid; verify renewal timing.', '',
        'A provisional shared monthly operating allowance is **$128.92**: Supabase $35 + Workers $5 + EAS $19 + assumed email $20 + assumed monitoring $20 + assumed backup services $20 + Apple $8.25 allocation + assumed domain $20/12. The last four service/domain allowances are not verified invoices; backup scope and extra compute must be checked. Development Claude/API spend, AI serving, support, consent, marketing and unknown contracts are additional. This baseline is not a capacity guarantee and is deliberately not subtracted from the scale tables as if it could serve every scale.', '',
        '## Workload assumptions per child per average month', '',
        '| Scenario | Pages | Original explanations | Follow-ups | Fresh daily sets | Thursday subjects |', '|---|---:|---:|---:|---:|---:|']
    for k,s in c['workloads'].items():
        lines.append(f"| {k.title()} | {s['pages']} | {s['explanations']} | {s['followups']} | {s['fresh_daily_sets']} | {s['thursday_subjects']} |")
    lines += ['', 'All scenarios retain five daily questions and eight Thursday questions per enabled subject, with 52/12 weeks/month. Semantic checking: 20% of practice responses. Extra difficult-page checks: 5% of pages. Verification is separately budgeted for homework, explanations, follow-ups, daily sets, longer Thursday bundles, semantic practice results and escalated results. A verifier must receive the full relevant context; an undersized token allowance cannot justify truncating its evidence. The adult summary is one family packet/week. A child count does not multiply that family packet.', '', '## Typical two-child AI detail', '', '| Stage | Model | Calls/month | Input/call | Billed output/call | Expected cost |','|---|---|---:|---:|---:|---:|']
    rows=ai_rows(2,'typical',c)
    for r in rows:
        lines.append(f"| {r['stage']} | {r['model']} | {r['calls']:.2f} | {r['input_per_call']:,.0f} | {r['output_per_call']:,.0f} | {money(r['expected_usd'])} |")
    subtotal=sum(r['expected_usd'] for r in rows)
    lines += ['',f'Expected AI: **{money(subtotal)}**; separate 25% uncertainty budget: **{money(subtotal*D(c["ai_contingency"]))}**; combined AI budget: **{money(subtotal*(1+D(c["ai_contingency"])))} per two-child family/month**. These are calculations from assumed calls/tokens, not observations. Input includes images and billed output includes reasoning. No additional per-image or reasoning multiplier is added.', '', '## Family economics at the approved prices', '', 'Assumes 1,000 identical paying families, 15% native fee, applicable 1% RevenueCat fee, zero commercial revenue, 1% gross refund allowance, $2 support/family, $5 consent allowance allocated over 12 months and $0.25 other variable allowance/family. Refunds conservatively do not reduce modeled fee bases. Actual refund treatment and consent charges must be reconciled. The last column is after AI contingency, before fixed overhead and unpriced costs; it is not net profit.', '', '| Usage | Children | Price | Expected AI | AI reserve | Channel + RC fees | Other variable allowances | Remaining before fixed/unpriced costs |', '|---|---:|---:|---:|---:|---:|---:|---:|']
    for workload in c['workloads']:
        for n in range(1,5):
            r=scenario_result(1000,n,workload,'native15',c)
            other=sum(r[k] for k in ['refund_allowance_usd','support_allowance_usd','consent_allocation_usd','other_variable_allowance_usd'])/1000
            lines.append(f"| {workload.title()} | {n} | {money(price(n))} | {money(r['expected_ai_usd']/1000)} | {money(r['ai_contingency_usd']/1000)} | {money((r['channel_fee_usd']+r['revenuecat_usd'])/1000)} | {money(other)} | **{money(r['budgeted_contribution_before_fixed_usd']/1000)}** |")
    one=scenario_result(1000,1,'typical','native15',c)
    two=scenario_result(1000,2,'typical','native15',c)
    delta=(two['budgeted_contribution_before_fixed_usd']-one['budgeted_contribution_before_fixed_usd'])/1000
    lines += ['', f'**Sibling economics:** each extra typical-use child reduces budgeted monthly contribution by approximately **{money(-delta)}** in this illustration. The $9.99 add-on leaves $8.39 after 15% + 1% fees, before extra AI/refund costs. This does not prove the price is wrong; it identifies a measurement and operating-budget decision. Keep the approved price until the owner changes it. With the separate uncertainty reserve, heavy families can have negative budgeted contribution before fixed overhead. Distinguish that downside budget from expected spend without the reserve.', '', '## Payment-route sensitivity: typical workload', '', '| Children | Native 15% + RC | Native 30% + RC | Direct web Stripe + Billing + RC |', '|---|---:|---:|---:|']
    for n in range(1,5):
        vals=[scenario_result(1000,n,'typical',route,c)['budgeted_contribution_before_fixed_usd']/1000 for route in ['native15','native30','web']]
        lines.append('| '+str(n)+' | '+' | '.join(money(v) for v in vals)+' |')
    lines += ['', 'All figures are budgeted contribution per family before fixed/unpriced costs. Web is an eligible direct adult website hypothetical, not a claim that native link-outs are allowed or exempt from store program fees. It assumes RevenueCat tracks those web subscriptions. Native rows contain no Stripe fee. Compare actual route eligibility, conversion, taxes and fees before enabling web checkout.', '', '## Scale and mixed-family view', '', 'Illustrative family mix: 40% one child, 30% two, 20% three, 10% four (average two children). Every family has typical usage here. RevenueCat threshold is applied once to the blended account total, not separately per cohort. These totals show the budget available for shared services and unpriced costs; they do not assert an infrastructure plan can support the load. Reassess annual Apple program eligibility at higher scale rather than extrapolating a reduced fee indefinitely; the 30% sensitivity remains separate.', '', '| Paying families | Gross/month | Budgeted contribution before fixed/unpriced costs |', '|---|---:|---:|']
    for n in [10,100,1000,10000]:
        r=mixed_result(n,'typical','native15',c)
        lines.append(f"| {n:,} | {money(r['gross_usd'])} | {money(r['budgeted_contribution_before_fixed_usd'])} |")
    lines += ['', 'The JSON includes all 144 combinations of 4 scales × 4 child counts × 3 usage levels × 3 payment routes, plus 36 mixed-family rows. A full operating forecast must add the measured infrastructure/support step costs and unpaid usage. No 10,000-family net-profit number is supplied because those inputs are not known.', '', '## Partial break-even sensitivity', '', 'Two children, typical use, native 15%, no commercial revenue, including the above allowances and AI contingency. Hypothetical fixed monthly expense inputs below are not vendor quotes. Recompute RevenueCat threshold at each candidate count. Other unknown expenses and acquisition costs remain excluded.', '', '| Hypothetical fixed monthly expense | First family count covering it in this partial model |', '|---|---:|']
    for fixed in [500,2000,10000]:
        lines.append(f'| {money(D(fixed))} | {break_even(D(fixed),c):,} |')
    lines += ['', 'No reliable total launch budget, first-year cash requirement or net profitability conclusion is possible yet. Next inputs: actual development/review quotes, consent/ZDR commercial terms, measured AI usage and quality, the family/usage/payment mix, verified store price availability, paid acquisition and retention, and infrastructure capacity tests. Section F of the master prompt requires Claude to obtain or explicitly model these inputs and update the report.', '']
    return '\n'.join(lines)

def main():
    c=json.loads((ROOT/'assumptions.json').read_text())
    if '--check' in sys.argv:
        checks(c)
        return
    rows=[scenario_result(f,n,u,ch,c) for f in [10,100,1000,10000] for n in range(1,5) for u in c['workloads'] for ch in ['native15','native30','web']]
    mixed=[mixed_result(f,u,ch,c) for f in [10,100,1000,10000] for u in c['workloads'] for ch in ['native15','native30','web']]
    (ROOT/'cost_report.md').write_text(report(c))
    (ROOT/'scenario_results.json').write_text(json.dumps({'status':'illustrative_unmeasured','scenarios':rows,'mixed_family_scenarios':mixed},indent=2,default=lambda x:float(x) if isinstance(x,Decimal) else x)+'\n')
    print(f'Generated report, {len(rows)} scenarios and {len(mixed)} mixed-family rows.')

if __name__ == '__main__':
    main()
