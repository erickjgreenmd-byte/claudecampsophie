"""Planning arithmetic, not provider billing or an implemented promo engine.
Run python3 finance/promo_school_model.py [--check].
Uses existing sourced baseline assumptions; no network or live transactions.
"""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import json
import sys
from cost_model import D, price, scenario_result, rc_fee, money
ROOT = Path(__file__).resolve().parent

def outcome(families, children, percent, channel, config, schools=1,
            workload='typical', other_tracked_revenue='0'):
    if not isinstance(percent, int) or isinstance(percent, bool) or not (percent == 0 or 5 <= percent <= 100):
        raise ValueError('0 means no promo; supported requested discounts are whole percentages 5–100')
    if type(schools) is not int or schools not in (0, 1):
        raise ValueError('One school per family: school count must be 0 or 1')
    other = D(other_tracked_revenue)
    if other < 0:
        raise ValueError('Other tracked revenue must be nonnegative')
    base = scenario_result(families, children, workload, channel, config)
    # Illustrative USD rounding; actual provider currency/price behavior must be verified.
    net_price = (price(children)*(1-D(percent)/100)).quantize(D('.01'), rounding=ROUND_HALF_UP)
    gross = net_price*families
    if channel == 'web':
        channel_fee = gross*(D(config['stripe']['processing_rate'])+D(config['stripe']['billing_rate']))
        if net_price > 0:
            channel_fee += families*D(config['stripe']['fixed_usd'])
    else:
        channel_fee = gross*D('.15' if channel == 'native15' else '.30')
    # Marginal change in account fee, including a cohort triggering the account threshold.
    rc = rc_fee(other+gross, config['revenuecat'])-rc_fee(other, config['revenuecat'])
    donation = D(families*schools) if (percent == 0 and net_price > 0) else D(0)
    refunds = gross*D(config['refund_allowance_rate'])
    costs = sum(base[k] for k in ['expected_ai_usd', 'ai_contingency_usd', 'support_allowance_usd',
                                  'consent_allocation_usd', 'other_variable_allowance_usd'])
    contribution = gross-channel_fee-rc-refunds-costs-donation
    return dict(families=families, children=children, percent=percent, channel=channel,
                workload=workload, schools_per_family=schools, donation_policy="full_price_only",
                other_tracked_revenue_usd=other, family_charge_usd=net_price, gross_usd=gross,
                discount_value_usd=base['gross_usd']-gross, channel_fee_usd=channel_fee,
                marginal_revenuecat_usd=rc, donation_usd=donation,
                expected_ai_usd=base['expected_ai_usd'], ai_contingency_usd=base['ai_contingency_usd'],
                budgeted_contribution_before_fixed_usd=contribution, net_profit_usd=None)

def checks(config):
    full=outcome(100,2,0,'native15',config)
    base=scenario_result(100,2,'typical','native15',config)
    assert abs(full['budgeted_contribution_before_fixed_usd']-(base['budgeted_contribution_before_fixed_usd']-100)) < D('0.000001')
    half=outcome(100,2,50,'web',config)
    assert half['family_charge_usd']==D('24.99') and half['gross_usd']==D('2499')
    assert half['marginal_revenuecat_usd']==0
    free=outcome(100,2,100,'web',config)
    assert free['gross_usd']==free['channel_fee_usd']==free['donation_usd']==0
    assert free['expected_ai_usd']==base['expected_ai_usd']
    for discount in range(5,101):
        assert outcome(100,2,discount,'web',config)['donation_usd']==0
    assert full['donation_usd']==100
    crossed=outcome(1,1,0,'native15',config,other_tracked_revenue='2490')
    assert crossed['marginal_revenuecat_usd']==D('25.2999')
    assert outcome(1,1,5,'native15',config)['family_charge_usd']==D('37.99')
    for p in [-1,1,4,101,True]:
        try: outcome(1,1,p,'web',config)
        except ValueError: pass
        else: raise AssertionError('Invalid percentage accepted')
    # Independent monthly cohorts: a fresh redemption produces another same-cost month;
    # lack of redemption returns to 0% discount. This is financial, not scheduling, evidence.
    months=[outcome(1,2,p,'native15',config) for p in [50,50,0]]
    assert [m['family_charge_usd'] for m in months]==[D('24.99'),D('24.99'),D('49.98')]
    assert [m['donation_usd'] for m in months]==[0,0,1]


def main():
    config=json.loads((ROOT/'assumptions.json').read_text())
    checks(config)
    if '--check' in sys.argv:
        print('Promo/school planning arithmetic checks passed; app behavior remains unimplemented.')
        return
    rows=[outcome(n,c,p,ch,config,schools=s,workload=w)
          for n in [10,100,1000,10000] for c in range(1,5) for p in [0,5,25,50,75,100]
          for ch in ['native15','native30','web'] for s in [1]
          for w in ['light','typical','heavy']]
    (ROOT/'promo_school_results.json').write_text(json.dumps(rows,indent=2,default=str)+'\n')
    lines=['# Monthly promotions and school contribution cost extension', '',
      'Planning illustration dated September 18, 2026. Base prices and usage assumptions are unchanged. '
      'Each newly redeemed monthly code may grant another discounted month; a prior code never renews itself. '
      'The baseline cost_report.md excludes promotions and school contributions. Use this extension for those cohorts.', '',
      '## Two-child family illustration', '',
      'Typical assumed usage, 100 identical families, native 15% fee, one designated school, '
      'owner-approved full-price-only donation policy, no other tracked account revenue. '
      'Contribution includes the existing AI reserve and variable allowances, before fixed and unpriced costs.', '',
      '| Discount this period | Family charge | School contribution/family | Budgeted contribution/family | Next period without a new code |',
      '|---|---:|---:|---:|---:|']
    for p in [0,5,25,50,75,100]:
        r=outcome(100,2,p,'native15',config)
        lines.append(f"| {p}% | {money(r['family_charge_usd'])} | {money(r['donation_usd']/100)} | {money(r['budgeted_contribution_before_fixed_usd']/100)} | {money(price(2))} |")
    lines+=['', '## Repeated monthly redemptions', '',
      'For a two-child family: a 50% code for one monthly period charges $24.99; a newly entered valid '
      '50% code for the next period charges $24.99 again; with no new code the following period charges $49.98. '
      'The cost model must not assume every family returns to full price in month two. '
      'A new valid 100% code every month can produce continuing zero revenue while service expenses continue.', '',
      '## Approved donation rule', '',
      'Each family supports one school. A settled full-price monthly subscription period generates $1; '
      'ANY discount generates $0, including 5%, 50% and 100%. A subsequent full-price renewal restores '
      'eligibility. Discounted families remain in school signup counts. The dated ledger assigns each '
      'eligible billing period to its start month and prevents duplicate family/month accruals. '
      'These steady-state financial scenarios do not implement billing events or the ledger.', '',
      f'The JSON contains {len(rows):,} scenarios across four scales, four child tiers, six discount cases, '
      'three channels, three workloads, one school and the full-price-only donation policy. Zero means a regular-price period. '
      'All whole discount percentages from 5 to 100 are accepted by the calculator. Provider catalogs may not represent '
      'every exact percentage; this arithmetic is not a verified native offer catalog.', '',
      'RevenueCat uses account-level thresholds. These scenarios assume no other tracked account revenue; '
      'outcome() accepts other_tracked_revenue for marginal account-fee calculations. Production forecasts must '
      'aggregate the actual mixture of full-price and discounted receipts before applying fees. '
      'Web examples charge no transaction fee for a zero-dollar period; actual contracts, fixed provider charges, '
      'taxes and native promotional rules must be verified. No native/web fees are stacked.', '',
      'Usage, support and consent allowances remain illustrative. School transfer fees, administration, '
      'fraud loss, campaign implementation labor, provider quotas and taxes remain unpriced; net profit is unknown. '
      'Budget campaigns on redeemed discounts plus ongoing service and donation costs, not merely code counts. '
      'A budget cap stops future issuance/redemption; it must not revoke an already confirmed benefit. '
      'Show 3/6/12-month cohorts, monthly redemption and retention rates, 100% repeat-redemption exposure, '
      'monthly school accruals and cash payout timing after actual data is available.']
    (ROOT/'promo_school_report.md').write_text('\n'.join(lines)+'\n')
    print(f'Generated {len(rows)} promo/school financial scenarios.')

if __name__=='__main__': main()
