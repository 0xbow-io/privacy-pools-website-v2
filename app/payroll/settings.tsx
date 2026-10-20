import { PayrollShell } from '@/components/payroll/payroll-shell';
import { PayrollSettings } from '@/components/payroll/settings';

export default function PayrollSettingsScreen() {
  return (
    <PayrollShell active="settings" title="Payroll settings" subtitle="Preferences, backups and data.">
      <PayrollSettings />
    </PayrollShell>
  );
}
