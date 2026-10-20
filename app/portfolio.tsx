import { PortfolioPageContent } from '@/components/portfolio/portfolio-page-content';

// Portfolio route — gated inside PortfolioPageContent on the fail-closed
// yield resolver (redirects home when yield is off for every chain).
export default function PortfolioRoute() {
  return <PortfolioPageContent />;
}
