import React, { useState } from 'react';
import { View, Text } from 'react-native';

import { PModal, PInput, PChip, FormField, PButton } from '@/components/payroll/ui';
import {
  upsertEmployee, newId, supportedNetworks, defaultNetwork, networkChainId, SOON_NETWORKS,
  type Employee, type EmployeeStatus,
} from '@/services/payroll-store';
import { getActionableTokens, getTokenMetadataBySymbol } from '@/config/tokens';
import { safeDecimalString } from '@/components/payroll/io';
import { displayTokenSymbol } from '@/services/share-display';

// (Replaced by the per-network list below — a static list offered assets
// with no contract on the selected network.)
const STATUSES: EmployeeStatus[] = ['active', 'onboarding', 'paused'];

export function EmployeeFormModal({ visible, employee, onClose }: {
  visible: boolean; employee: Employee | null; onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [network, setNetwork] = useState<string>(defaultNetwork());
  const [salary, setSalary] = useState('');
  const [currency, setCurrency] = useState('USDC');
  const [status, setStatus] = useState<EmployeeStatus>('active');
  const [error, setError] = useState<string | null>(null);

  // Reset the form to the selected employee whenever the modal opens or the
  // target employee changes while it is open. Written as an adjust-state-
  // during-render (React's recommended alternative to a setState-in-effect)
  // so the compiler can optimize this component.
  const [synced, setSynced] = useState<{ visible: boolean; employee: Employee | null }>({
    visible: false,
    employee: null,
  });
  if (synced.visible !== visible || synced.employee !== employee) {
    setSynced({ visible, employee });
    if (visible) {
      setName(employee?.name ?? '');
      setRole(employee?.role ?? '');
      setWalletAddress(employee?.walletAddress ?? '');
      setNetwork(employee?.network ?? defaultNetwork());
      setSalary(employee?.salaryText ?? (employee?.salary ? safeDecimalString(employee.salary) : ''));
      setCurrency(employee?.currency ?? 'USDC');
      setStatus(employee?.status ?? 'active');
      setError(null);
    }
  }

  // The assets that actually exist on the selected network's registry —
  // Citrea offers only cBTC, so the old static ETH/USDC/USDT list could
  // select currencies that resolve to nothing at pay time.
  const formChainId = networkChainId(network);
  const currencyOptions = formChainId !== undefined
    ? getActionableTokens(formChainId).map((t) => t.symbol)
    : ['USDC'];

  const save = () => {
    // Validate the WHOLE string as a plain decimal (codex round 3):
    // parseFloat accepted '1abc' and precision-lossy values; the stored
    // salaryText is the EXECUTABLE amount, salary:number is display-only.
    const salaryText = salary.trim();
    if (!name.trim()) return setError('Name is required.');
    if (!/^\d+(\.\d+)?$/.test(salaryText) || !Number.isFinite(Number(salaryText)) || !(Number(salaryText) > 0)) {
      return setError('Enter the salary as a plain positive number (e.g. 1500 or 0.25).');
    }
    // The currency must exist on the chosen network's registry — a symbol
    // with no contract there would fall back to the native asset at pay time.
    const chainForNetwork = networkChainId(network);
    const tokenMeta = chainForNetwork !== undefined ? getTokenMetadataBySymbol(currency, chainForNetwork) : undefined;
    if (!tokenMeta) {
      return setError(`${displayTokenSymbol(currency)} is not available on ${network}. Pick one of this network's assets.`);
    }
    // The amount must be representable in the token's precision — extra
    // fraction digits silently round at parseUnits (0.0000001 USDC → 0).
    const fracDigits = (salaryText.split('.')[1] ?? '').length;
    if (fracDigits > tokenMeta.decimals) {
      return setError(`${displayTokenSymbol(currency)} supports ${tokenMeta.decimals} decimal places. This amount has ${fracDigits}.`);
    }
    upsertEmployee({
      id: employee?.id ?? newId('emp'),
      name: name.trim(),
      role: role.trim(),
      walletAddress: walletAddress.trim(),
      network,
      salary: Number(salaryText),
      salaryText,
      currency,
      status,
      createdAt: employee?.createdAt ?? Date.now(),
    });
    onClose();
  };

  return (
    <PModal
      visible={visible}
      onClose={onClose}
      title={employee ? 'Edit team member' : 'Add team member'}
      footer={
        <>
          <PButton label="Cancel" variant="outline" onPress={onClose} className="flex-1" />
          <PButton label={employee ? 'Save' : 'Add'} onPress={save} className="flex-1" />
        </>
      }
    >
      <FormField label="Name"><PInput value={name} onChangeText={setName} placeholder="Alice Smith" /></FormField>
      <FormField label="Role"><PInput value={role} onChangeText={setRole} placeholder="Senior Engineer" /></FormField>
      <FormField label="Wallet address"><PInput value={walletAddress} onChangeText={setWalletAddress} placeholder="0x…" /></FormField>
      <FormField label="Network">
        <View className="flex-row flex-wrap gap-[8px]">
          {supportedNetworks().map((n) => (
            <PChip key={n} label={n} selected={n === network} onPress={() => setNetwork(n)} />
          ))}
          {SOON_NETWORKS.map((n) => (
            <View key={n} className="flex-row items-center gap-[6px] rounded-control border border-border-light px-[13px] py-[7px] opacity-[0.55]">
              <Text className="font-pp-sans-medium text-[12px] text-text-muted">{n}</Text>
              <Text className="font-pp-regular text-[9px] uppercase tracking-[0.5px] text-text-muted">soon</Text>
            </View>
          ))}
        </View>
      </FormField>
      <View className="flex-row gap-[12px]">
        <View className="flex-1"><FormField label="Salary (monthly)"><PInput value={salary} onChangeText={setSalary} placeholder="5000" keyboardType="numeric" /></FormField></View>
        <View className="flex-1"><FormField label="Currency"><Chips options={currencyOptions} value={currency} onPick={setCurrency} labelOf={displayTokenSymbol} /></FormField></View>
      </View>
      <FormField label="Status"><Chips options={STATUSES} value={status} onPick={setStatus} /></FormField>
      {error ? <Text className="font-pp-sans-medium text-[12px] text-danger">{error}</Text> : null}
    </PModal>
  );
}

function Chips<T extends string>({ options, value, onPick, labelOf }: {
  options: readonly T[]; value: T; onPick: (v: T) => void;
  /** Chip text for an option; the default capitalises it. A share option reads as its coin. */
  labelOf?: (o: T) => string;
}) {
  return (
    <View className="flex-row flex-wrap gap-[8px]">
      {options.map((o) => (
        <PChip key={o} label={labelOf ? labelOf(o) : o.charAt(0).toUpperCase() + o.slice(1)} selected={o === value} onPress={() => onPick(o)} />
      ))}
    </View>
  );
}
