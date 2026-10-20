import React from 'react';
import { View, Text, Alert } from 'react-native';

import { usePayroll } from '@/hooks/use-payroll';
import {
  saveSettings, exportAll, exportEmployees, exportRuns, importData, clearAllPayrollData,
} from '@/services/payroll-store';
import { PCard, PButton, PSegmented, CardTitle, type SegmentedOption } from '@/components/payroll/ui';
import { downloadText, pickTextFile } from '@/components/payroll/io';

const CURRENCY_OPTIONS: readonly SegmentedOption<'USD' | 'EUR'>[] = [
  { value: 'USD', label: 'USD' },
  { value: 'EUR', label: 'EUR' },
];


export function PayrollSettings() {
  const { settings, employees, runs } = usePayroll();

  const onImport = async () => {
    const text = await pickTextFile();
    if (!text) return;
    try {
      const r = importData(text, 'merge');
      Alert.alert('Imported', `${r.employees} employee(s), ${r.runs} run(s)${r.settings ? ', settings' : ''} merged.`);
    } catch {
      Alert.alert('Import failed', 'That file isn’t a valid payroll export.');
    }
  };

  const clearAll = () => {
    const doIt = () => clearAllPayrollData();
    if (typeof window !== 'undefined' && window.confirm) { if (window.confirm('Delete ALL payroll data on this device? This cannot be undone.')) doIt(); }
    else Alert.alert('Clear all data', 'Delete ALL payroll data on this device?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: doIt }]);
  };

  return (
    <View className="gap-[16px]">
      <PCard className="gap-[16px]">
        <CardTitle>Preferences</CardTitle>
        <View className="flex-row items-center gap-[12px]">
          <View className="flex-1">
            <Text className="font-pp-sans-medium text-[14px] text-text">Display currency</Text>
            <Text className="font-pp-sans text-[12px] leading-[18px] text-text-secondary">Currency for the fiat values shown across payroll. Rates from the ECB, updated daily.</Text>
          </View>
          <PSegmented
            value={settings.displayCurrency}
            onChange={(v) => saveSettings({ displayCurrency: v })}
            options={CURRENCY_OPTIONS}
          />
        </View>
      </PCard>

      <PCard className="gap-[12px]">
        <CardTitle>Backup & import</CardTitle>
        <Text className="font-pp-sans text-[12px] leading-[18px] text-text-secondary">
          All payroll data lives only in this browser. Export to back it up or move devices. Currently {employees.length} employee(s), {runs.length} run(s).
        </Text>
        <View className="flex-row flex-wrap gap-[10px]">
          <PButton label="Export all" icon="download-outline"
            onPress={() => downloadText(`payroll-all-${new Date().toISOString().slice(0, 10)}.json`, exportAll())} />
          <PButton label="Export team" icon="people-outline" variant="outline"
            onPress={() => downloadText(`payroll-employees-${new Date().toISOString().slice(0, 10)}.json`, exportEmployees())} />
          <PButton label="Export history" icon="time-outline" variant="outline"
            onPress={() => downloadText(`payroll-history-${new Date().toISOString().slice(0, 10)}.json`, exportRuns())} />
          <PButton label="Import" icon="cloud-upload-outline" variant="outline" onPress={onImport} />
        </View>
      </PCard>

      <PCard className="gap-[12px]">
        <CardTitle>Danger zone</CardTitle>
        <Text className="font-pp-sans text-[12px] leading-[18px] text-text-secondary">Permanently delete all employees, history and settings from this device.</Text>
        <PButton label="Clear all payroll data" icon="trash-outline" variant="danger" onPress={clearAll} className="self-start" />
      </PCard>
    </View>
  );
}
