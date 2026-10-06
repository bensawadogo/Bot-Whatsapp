import { tierFromRating } from '../src/modules/campaigns/campaign.service';
import type { MessagingTier } from '../src/modules/campaigns/campaign.types';

describe('tierFromRating', () => {
  it('GREEN maps to TIER_1', () => {
    expect(tierFromRating('GREEN' as any)).toBe('TIER_1' as MessagingTier);
  });
  it('YELLOW maps to TIER_1', () => {
    expect(tierFromRating('YELLOW' as any)).toBe('TIER_1' as MessagingTier);
  });
  it('RED maps to TIER_0', () => {
    expect(tierFromRating('RED' as any)).toBe('TIER_0' as MessagingTier);
  });
});