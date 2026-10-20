import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, Alert } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { usePayroll } from '@/hooks/use-payroll';
import {
  deleteEmployee, exportEmployees, importData, supportedNetworks, type Employee,
} from '@/services/payroll-store';
import { PCard, PBadge, PButton, PChip, PIconButton, CardEmptyState, useC, shortAddr, fmtToken } from '@/components/payroll/ui';
import { EmployeeFormModal } from '@/components/payroll/employee-form-modal';
import { downloadText, pickTextFile } from '@/components/payroll/io';

export function PayrollEmployees() {
  const c = useC();
  const { employees } = usePayroll();
  const [q, setQ] = useState('');
  const [network, setNetwork] = useState<string>('All');
  const [editing, setEditing] = useState<Employee | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return employees.filter((e) => {
      if (network !== 'All' && e.network !== network) return false;
      if (!needle) return true;
      return [e.name, e.role, e.walletAddress].some((f) => f.toLowerCase().includes(needle));
    });
  }, [employees, q, network]);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (e: Employee) => { setEditing(e); setFormOpen(true); };

  const remove = (e: Employee) => {
    const doIt = () => deleteEmployee(e.id);
    if (typeof window !== 'undefined' && window.confirm) { if (window.confirm(`Remove ${e.name}?`)) doIt(); }
    else Alert.alert('Remove team member', `Remove ${e.name}?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: doIt }]);
  };

  const onImport = async () => {
    const text = await pickTextFile();
    if (!text) return;
    try {
      const r = importData(text, 'merge');
      Alert.alert('Imported', `${r.employees} employee record(s) merged.`);
    } catch {
      Alert.alert('Import failed', 'That file isn’t a valid payroll export.');
    }
  };

  return (
    <View className="gap-[16px]">
      <View className="flex-row flex-wrap items-center justify-between gap-[10px]">
        <View className="min-w-[200px] grow flex-row items-center gap-[8px] rounded-control border border-border-light px-[12px] py-[9px]">
          {/* nw-keep(data-color): muted search glyph color (theme token) into the vector-icon sink */}
          <Ionicons name="search" size={15} color={c.textMuted} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search name, role or address"
            // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
            placeholderTextColor={c.textMuted}
            autoCapitalize="none"
            className="flex-1 font-pp-regular text-[13px] text-text"
          />
        </View>
        <View className="flex-row flex-wrap gap-[8px]">
          <PButton label="Add" icon="person-add-outline" onPress={openAdd} />
          <PButton label="Export" icon="download-outline" variant="outline"
            onPress={() => downloadText(`payroll-employees-${new Date().toISOString().slice(0, 10)}.json`, exportEmployees())} />
          <PButton label="Import" icon="cloud-upload-outline" variant="outline" onPress={onImport} />
        </View>
      </View>

      <View className="flex-row flex-wrap gap-[8px]">
        {['All', ...supportedNetworks()].map((n) => (
          <PChip key={n} label={n} selected={n === network} onPress={() => setNetwork(n)} />
        ))}
      </View>

      {filtered.length === 0 ? (
        <PCard>
          <CardEmptyState
            icon="people-outline"
            description={employees.length === 0 ? 'No team members yet. Add your first one.' : 'No matches for these filters.'}
          >
            {employees.length === 0 ? <PButton label="Add team member" icon="person-add-outline" onPress={openAdd} /> : null}
          </CardEmptyState>
        </PCard>
      ) : (
        <View className="gap-[10px]">
          {filtered.map((e) => (
            <PCard key={e.id} className="flex-row flex-wrap items-center gap-[12px]">
              <View className="min-w-[160px] flex-1 gap-[3px]">
                <Text className="font-pp-sans-semi-bold text-[14px] text-text">{e.name}</Text>
                <Text className="font-pp-sans text-[12px] text-text-secondary" numberOfLines={1}>{e.role || '—'}</Text>
                <Text className="font-pp-sans text-[12px] text-text-secondary">{shortAddr(e.walletAddress)}</Text>
              </View>
              <View className="items-start gap-[6px]">
                <PBadge label={e.network} />
                <Text className="font-pp-sans-medium text-[13px] text-text">{fmtToken(e.salary, e.currency)}/mo</Text>
              </View>
              <View className="items-end gap-[8px]">
                <PBadge label={e.status} variant={e.status === 'active' ? 'success' : e.status === 'onboarding' ? 'warning' : 'default'} />
                <View className="flex-row gap-[10px]">
                  <PIconButton name="create-outline" tone="foreground" accessibilityLabel="Edit team member" onPress={() => openEdit(e)} />
                  <PIconButton name="trash-outline" tone="danger" accessibilityLabel="Remove team member" onPress={() => remove(e)} />
                </View>
              </View>
            </PCard>
          ))}
        </View>
      )}

      <EmployeeFormModal visible={formOpen} employee={editing} onClose={() => setFormOpen(false)} />
    </View>
  );
}
