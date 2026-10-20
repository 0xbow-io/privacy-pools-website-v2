import { PayrollShell } from '@/components/payroll/payroll-shell';
import { PayrollRunView } from '@/components/payroll/run';

export default function PayrollRunScreen() {
  return (
    <PayrollShell active="run" title="Run payroll" subtitle="Review the run and pay each person as an individual private transfer you sign.">
      <PayrollRunView />
    </PayrollShell>
  );
}
