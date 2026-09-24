// Parent-defined rewards (spec P9, P16.3, P16.4). A reward is a family record that a parent
// fulfills outside the app; the app never pays, buys, links to a merchant or transfers anything.
import { err, ok, type Result } from '../shared/result.ts';
import { isValidId } from './ids.ts';
import { MAX_REWARD_POINT_COST, isValidPointCost, type RewardOffer } from './redemption.ts';
import { codePointLength, isMeaningfulText } from './text.ts';

export const MAX_REWARD_TITLE_LENGTH = 80;
export const MAX_REWARD_INSTRUCTIONS_LENGTH = 500;

export interface RewardDefinitionInput {
  readonly id: string;
  readonly title: string;
  readonly pointCost: number;
  readonly instructions?: string;
  /** Id of a family-uploaded image asset; never a remote URL. */
  readonly imageAssetId?: string;
  readonly active: boolean;
}

export interface RewardDefinition extends RewardOffer {
  readonly title: string;
  readonly instructions?: string;
  readonly imageAssetId?: string;
  /** The only fulfillment mode: the parent gives the reward outside the app and records it. */
  readonly fulfillment: 'parent_outside_app';
}

export const REWARD_DEFINITION_ERROR_CODES = [
  'INVALID_REWARD_ID',
  'TITLE_REQUIRED',
  'TEXT_TOO_LONG',
  'LINK_NOT_ALLOWED',
  'INVALID_POINT_COST',
] as const;
export type RewardDefinitionErrorCode = (typeof REWARD_DEFINITION_ERROR_CODES)[number];

/**
 * Decision: reward text is child-visible and P16.3 forbids affiliate URLs in a learning reward, so
 * reward titles and instructions may not contain any link: a URL scheme, `www.`, or a bare host
 * name with a common public suffix (e.g. amzn.to, a.co). Ordinary prose such as "Dr. Seuss book"
 * or "2.5 hours" is unaffected.
 */
const LINK_PATTERN =
  /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|co|io|app|shop|store|ly|me|to|us|uk|ca|au|de|in|biz|info|link|gl|gd|site|online|xyz)\b/i;

function containsLink(text: string): boolean {
  return LINK_PATTERN.test(text);
}

/** Validates a parent-entered reward. Text is trimmed and treated as untrusted display data. */
export function validateRewardDefinition(
  input: RewardDefinitionInput,
): Result<RewardDefinition, RewardDefinitionErrorCode> {
  if (!isValidId(input.id)) return err('INVALID_REWARD_ID', 'Reward id is not a valid identifier');
  if (input.imageAssetId !== undefined && !isValidId(input.imageAssetId)) {
    return err('INVALID_REWARD_ID', 'Reward image must be an uploaded asset id');
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!isMeaningfulText(title)) return err('TITLE_REQUIRED', 'Give the reward a name');
  if (codePointLength(title) > MAX_REWARD_TITLE_LENGTH) {
    return err('TEXT_TOO_LONG', `Keep the name under ${MAX_REWARD_TITLE_LENGTH} characters`);
  }
  const instructions =
    typeof input.instructions === 'string' ? input.instructions.trim() : undefined;
  if (
    instructions !== undefined &&
    codePointLength(instructions) > MAX_REWARD_INSTRUCTIONS_LENGTH
  ) {
    return err(
      'TEXT_TOO_LONG',
      `Keep the instructions under ${MAX_REWARD_INSTRUCTIONS_LENGTH} characters`,
    );
  }
  if (containsLink(title) || (instructions !== undefined && containsLink(instructions))) {
    return err('LINK_NOT_ALLOWED', 'Rewards cannot contain links or shopping URLs');
  }
  if (!isValidPointCost(input.pointCost)) {
    return err(
      'INVALID_POINT_COST',
      `A reward must cost an integer from 1 to ${MAX_REWARD_POINT_COST} points`,
    );
  }
  return ok({
    id: input.id,
    title,
    pointCost: input.pointCost,
    ...(instructions !== undefined && instructions.length > 0 ? { instructions } : {}),
    ...(input.imageAssetId !== undefined ? { imageAssetId: input.imageAssetId } : {}),
    active: input.active === true,
    fulfillment: 'parent_outside_app',
  });
}
