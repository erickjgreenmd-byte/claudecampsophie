import { describe, expect, it } from 'vitest';
import {
  MAX_REWARD_INSTRUCTIONS_LENGTH,
  MAX_REWARD_POINT_COST,
  MAX_REWARD_TITLE_LENGTH,
  validateRewardDefinition,
  type RewardDefinitionInput,
} from './index.ts';
import { errorCode, unwrap } from './test-fixtures.ts';

const FIVE_DOLLARS: RewardDefinitionInput = {
  id: 'reward-five-dollars',
  title: '  $5 from Mom  ',
  pointCost: 60,
  instructions: 'Paid outside the app on Saturday.',
  active: true,
};

describe('parent-defined rewards are family records fulfilled outside the app (P9, AC_REWARDS_04)', () => {
  it('accepts a cash-style reward as a parent-fulfilled record with trimmed text', () => {
    expect(unwrap(validateRewardDefinition(FIVE_DOLLARS))).toEqual({
      id: 'reward-five-dollars',
      title: '$5 from Mom',
      pointCost: 60,
      instructions: 'Paid outside the app on Saturday.',
      active: true,
      fulfillment: 'parent_outside_app',
    });
  });

  it('accepts a reward without instructions or image', () => {
    const value = unwrap(
      validateRewardDefinition({
        id: 'reward-zoo',
        title: 'Trip to the zoo',
        pointCost: 200,
        active: true,
      }),
    );
    expect(value).not.toHaveProperty('instructions');
    expect(value).not.toHaveProperty('imageAssetId');
  });

  it.each(['', '   ', '!!!'])('requires a meaningful title (%j)', (title) => {
    expect(errorCode(validateRewardDefinition({ ...FIVE_DOLLARS, title }))).toBe('TITLE_REQUIRED');
  });

  it('bounds untrusted text length', () => {
    expect(
      errorCode(
        validateRewardDefinition({
          ...FIVE_DOLLARS,
          title: 'b'.repeat(MAX_REWARD_TITLE_LENGTH + 1),
        }),
      ),
    ).toBe('TEXT_TOO_LONG');
    expect(
      errorCode(
        validateRewardDefinition({
          ...FIVE_DOLLARS,
          instructions: 'c'.repeat(MAX_REWARD_INSTRUCTIONS_LENGTH + 1),
        }),
      ),
    ).toBe('TEXT_TOO_LONG');
  });

  it.each([0, -1, 2.5, MAX_REWARD_POINT_COST + 1])('rejects a point cost of %s', (pointCost) => {
    expect(errorCode(validateRewardDefinition({ ...FIVE_DOLLARS, pointCost }))).toBe(
      'INVALID_POINT_COST',
    );
  });

  it('rejects an id that cannot form a safe key', () => {
    expect(errorCode(validateRewardDefinition({ ...FIVE_DOLLARS, id: 'reward:1' }))).toBe(
      'INVALID_REWARD_ID',
    );
    expect(
      errorCode(
        validateRewardDefinition({ ...FIVE_DOLLARS, imageAssetId: 'https://x.test/a.png' }),
      ),
    ).toBe('INVALID_REWARD_ID');
  });
});

describe('no affiliate or merchant links in a learning reward (P16.3, P16.4, AC_MON_13)', () => {
  it.each([
    ['title', 'Book https://www.amazon.com/dp/B000?tag=owner-20'],
    ['title', 'Headphones from amzn.to/3xYz'],
    ['instructions', 'Order it at www.example-shop.com for Riley'],
    ['instructions', 'See a.co/d/abc123'],
    ['instructions', 'HTTP://SHOP.EXAMPLE.NET/deal'],
  ] as const)('rejects a link in the %s: %s', (field, text) => {
    expect(errorCode(validateRewardDefinition({ ...FIVE_DOLLARS, [field]: text }))).toBe(
      'LINK_NOT_ALLOWED',
    );
  });

  it.each(['A new book from the bookstore', 'Dr. Seuss book', 'Pick 2.5 hours of park time'])(
    'ordinary text %j is not mistaken for a link',
    (title) => {
      expect(validateRewardDefinition({ ...FIVE_DOLLARS, title }).ok).toBe(true);
    },
  );
});
