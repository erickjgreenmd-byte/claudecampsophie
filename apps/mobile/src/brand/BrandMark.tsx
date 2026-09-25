import { Image, StyleSheet, View } from 'react-native';
import { brand, spacing } from '@pencillift/ui-tokens';
import symbol256 from '../../assets/brand/symbol-256.png';
import symbol512 from '../../assets/brand/symbol-512.png';

/**
 * The PencilLift symbol as an in-app mark (brand/ASSETS.md; traced from the approved reference,
 * full colour, never the tagline). The image itself carries the brand name for screen readers, so
 * no text repeats it beside the mark. Where a text wordmark already names the brand (the welcome
 * screen), the image is decorative and hidden from assistive technology instead.
 */

export const BRAND_MARK_SIZES = { sm: 24, md: 36 } as const;
export type BrandMarkSize = keyof typeof BRAND_MARK_SIZES;

export function BrandMark({
  size = 'md',
  decorative = false,
}: {
  size?: BrandMarkSize | undefined;
  decorative?: boolean | undefined;
}) {
  return (
    <Image
      source={symbol256}
      style={styles[size]}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel={decorative ? undefined : brand.name}
      accessible={!decorative}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'}
      aria-hidden={decorative}
    />
  );
}

/** Brand row for the top of a screen: the mark and nothing else; the screen title stays the H1. */
export function BrandRow() {
  return (
    <View style={styles.row}>
      <BrandMark size="md" />
    </View>
  );
}

/**
 * Large full-colour symbol for the welcome screen. It sits above the text wordmark, which names
 * the brand, so the image is decorative there (no duplicate "PencilLift" announcement).
 */
export function BrandHero() {
  return (
    <Image
      source={symbol512}
      style={styles.hero}
      resizeMode="contain"
      accessibilityRole="image"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
    />
  );
}

export const BRAND_HERO_SIZE = 144;

const styles = StyleSheet.create({
  sm: { width: BRAND_MARK_SIZES.sm, height: BRAND_MARK_SIZES.sm },
  md: { width: BRAND_MARK_SIZES.md, height: BRAND_MARK_SIZES.md },
  hero: { width: BRAND_HERO_SIZE, height: BRAND_HERO_SIZE, marginBottom: spacing.sm },
  row: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
});
