import { PayrollShell } from '@/components/payroll/payroll-shell';
import { PayrollHistory } from '@/components/payroll/history';

export default function PayrollHistoryScreen() {
  return (
    <PayrollShell active="history" title="Payroll history" subtitle="Past runs and treasury movements.">
      <PayrollHistory />
    </PayrollShell>
  );
}
