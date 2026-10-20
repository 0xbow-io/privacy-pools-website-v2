import { PayrollShell } from '@/components/payroll/payroll-shell';
import { PayrollDashboard } from '@/components/payroll/dashboard';

export default function PayrollDashboardScreen() {
  return (
    <PayrollShell active="dashboard" title="Treasury & payroll" subtitle="Pay your team monthly from your Privacy Pools balance.">
      <PayrollDashboard />
    </PayrollShell>
  );
}
