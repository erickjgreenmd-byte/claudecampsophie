import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '@pencillift/ui-tokens';

/**
 * Child space. Only child-scoped data; no ads, purchases, answer keys or adult screens. There is
 * no native header here, so the layout keeps every child screen (and its brand row) below the
 * status bar; a screen that also applies its own top edge measures zero once inside this one.
 */
export default function ChildLayout() {
  return (
    <SafeAreaView style={styles.fill} edges={['top']}>
      <Stack screenOptions={{ headerShown: false, contentStyle: styles.fill }} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.offWhite },
});
