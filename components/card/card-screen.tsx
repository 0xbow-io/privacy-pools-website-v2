import { Redirect } from 'expo-router';

/** The Card screen is native-app only; on web /card goes home. */
export function CardScreen() {
  return <Redirect href="/" />;
}
