import { useQuery } from '@tanstack/react-query';

import { usePayroll } from '@/hooks/use-payroll';
import { getUsdToEurRate } from '@/services/fx-rate';
import { formatFiat, formatFiatFull, type FiatCurrency } from '@/components/payroll/format';

// Bridges the payroll display-currency setting to the format layer: reads the
// chosen currency, fetches the USD→EUR rate only when EUR is selected (cached
// half a day, since the ECB rate moves once a business day), and returns
// USD-in → formatted-string-out helpers the payroll surfaces call in place of
// formatUsd/formatUsdPrecise. USD needs no rate, so it never hits the network.
export function usePayrollDisplayCurrency(): {
  currency: FiatCurrency;
  rate: number;
  /** Compact form (k/M/B): treasury, chart bar labels. */
  format: (usd: number) => string;
  /** Full number, cents only when small: headline run totals and stats. */
  formatFull: (usd: number) => string;
} {
  const { settings } = usePayroll();
  const currency = settings.displayCurrency;

  const { data: rate = 1 } = useQuery({
    queryKey: ['fxRate', 'USD', 'EUR'],
    queryFn: getUsdToEurRate,
    staleTime: 12 * 60 * 60 * 1000, // 12h
    enabled: currency === 'EUR',
  });

  return {
    currency,
    rate,
    format: (usd: number) => formatFiat(usd, currency, rate),
    formatFull: (usd: number) => formatFiatFull(usd, currency, rate),
  };
}
