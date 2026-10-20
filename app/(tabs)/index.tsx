import { HomeScreen as VaultHome } from '@/components/home/home-screen';

// The classic pools landing page retired with design variant 0 (2026-08-18);
// every variant renders the vault home, styled purely through the variant
// token sets in constants/theme.
export default function HomeScreen() {
  return <VaultHome />;
}
