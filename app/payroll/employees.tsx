import { PayrollShell } from '@/components/payroll/payroll-shell';
import { PayrollEmployees } from '@/components/payroll/employees';

export default function PayrollEmployeesScreen() {
  return (
    <PayrollShell active="employees" title="Team directory" subtitle="Manage who gets paid, their wallets and salaries.">
      <PayrollEmployees />
    </PayrollShell>
  );
}
