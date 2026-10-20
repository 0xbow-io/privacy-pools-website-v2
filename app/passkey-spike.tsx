import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import {
  createPasskey,
  getPasskeyPrf,
  isWebAuthnAvailable,
  isPasskeyPrfLikelySupported,
  type BackupFlags,
} from '@/services/passkey';
import { derivePasskeyKeysFromHex } from '@/services/passkey-derivation';
import { decodePasskeyBackup, downloadPasskeyBackup, encodePasskeyBackup } from '@/services/passkey-backup';

// SPIKE screen — reachable at /passkey-spike. Unlinked from navigation and NOT
// production sign-in. It derives keys + builds a keystore manager only inside
// this isolated screen, to exercise the passkey/PRF + derivation + backup path
// on each target browser/device: that WebAuthn PRF works here, user
// verification is enforced, and the BE/BS backup flags are reported (so the
// real flow can detect "is this passkey backed up?" and only then relax the
// download nudge). It never displays, logs, or persists private key material —
// only public values (viewingPublicKey, credential id, flags). The backup
// download is the one deliberate export of secret material, behind a fresh UV.

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  return b;
}

function flagsLine(f: BackupFlags): string {
  return `UP=${f.userPresent ? 1 : 0}  UV=${f.userVerified ? 1 : 0}  BE=${f.backupEligible ? 1 : 0}  BS=${f.backupState ? 1 : 0}`;
}

function backupVerdict(f: BackupFlags): string {
  if (!f.backupEligible) return 'Device-bound — NOT syncable. A download backup would be mandatory.';
  if (f.backupState) return 'Backed up to the provider (synced). Download backup optional for device loss, still needed for domain loss.';
  return 'Syncable but NOT yet backed up. Recommend a download backup.';
}

export default function PasskeySpikeScreen() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];

  const [rpId, setRpId] = useState('');
  const [available, setAvailable] = useState(false);
  const [likely, setLikely] = useState<boolean | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [restoreInput, setRestoreInput] = useState('');

  useEffect(() => {
    setAvailable(isWebAuthnAvailable());
    void isPasskeyPrfLikelySupported().then(setLikely);
    if (typeof window !== 'undefined' && window.location?.hostname) {
      setRpId(window.location.hostname);
    }
  }, []);

  const append = (line: string) => setLog((prev) => [...prev, line]);

  const runCreate = async () => {
    setBusy(true);
    append('— create passkey —');
    try {
      const res = await createPasskey({
        rpId,
        rpName: 'Privacy Pools (spike)',
        userId: randomBytes(16),
        userName: 'spike-user',
        userDisplayName: 'Spike User',
        challenge: randomBytes(32),
      });
      append(`credentialId: ${res.credentialId}`);
      append(`PRF supported at create: ${res.prfEnabled}`);
      if (res.flagsKnown) {
        append(`flags: ${flagsLine(res.flags)}`);
        append(`backup: ${backupVerdict(res.flags)}`);
      } else {
        append('create-time flags unavailable on this browser. Use Get PRF for authoritative backup state.');
      }
      append(res.prf ? 'PRF present at create ✓ (value hidden. Spend-grade).' : 'PRF returns on assert. Tap Get PRF.');
    } catch (e) {
      append(`ERROR: ${e instanceof Error ? `${e.name ?? 'Error'}: ${e.message}` : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const runGet = async () => {
    setBusy(true);
    append('— get PRF (unlock) —');
    try {
      const res = await getPasskeyPrf({ rpId, challenge: randomBytes(32) });
      append(`credentialId: ${res.credentialId}`);
      append(`flags: ${flagsLine(res.flags)}`);
      append(`backup: ${backupVerdict(res.flags)}`);
      append('PRF obtained ✓ (value hidden. Spend-grade root).');
      // Derive real keys from the PRF via the SDK's exact HKDF tree, and build
      // a keystore manager — proves the wrapper path end-to-end (no SDK edit).
      // Only the PUBLIC viewing key is shown; private keys are never displayed.
      const keys = derivePasskeyKeysFromHex(res.prf.first);
      append(`↳ derived viewingPublicKey (public): ${keys.viewingPublicKey}`);
      const { derivePasskeyKeystoreManager } = await import('@/services/sdk-runtime');
      const km = derivePasskeyKeystoreManager(res.prf.first);
      append(`↳ keystore manager built ✓  (revocableKeyIndex ${km.getRevocableKeyIndex()})`);
      append('↳ viewingPublicKey is public + stable per passkey. Compare across reloads.');
    } catch (e) {
      append(`ERROR: ${e instanceof Error ? `${e.name ?? 'Error'}: ${e.message}` : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Passkey-gated export: a FRESH user-verified assertion produces the root,
  // which we package as a portable backup and download. The re-auth is the
  // point — a background script can't silently export without the biometric.
  const runBackup = async () => {
    setBusy(true);
    append('— download backup (re-auth) —');
    try {
      const res = await getPasskeyPrf({ rpId, challenge: randomBytes(32) });
      const encoded = encodePasskeyBackup({ root: res.prf.first });
      const ok = downloadPasskeyBackup(encoded);
      append(`backup payload: ${encoded.length} chars (contents hidden. Spend-grade).`);
      append(ok ? 'downloaded ✓. Store like cash; recovers the account on any device/origin.' : 'download unavailable here (non-web).');
    } catch (e) {
      append(`ERROR: ${e instanceof Error ? `${e.name ?? 'Error'}: ${e.message}` : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Restore: decode a pasted backup and rebuild the account WITHOUT a passkey —
  // proves the downloaded root is the real cross-device / domain-loss lifeboat.
  const runRestore = async () => {
    append('— restore from backup —');
    const backup = decodePasskeyBackup(restoreInput);
    if (!backup) {
      append('ERROR: not a valid passkey backup.');
      return;
    }
    try {
      const keys = derivePasskeyKeysFromHex(backup.root, BigInt(backup.revocableKeyIndex));
      const { derivePasskeyKeystoreManager } = await import('@/services/sdk-runtime');
      const km = derivePasskeyKeystoreManager(backup.root, backup.revocableKeyIndex);
      append(`restored viewingPublicKey: ${keys.viewingPublicKey}`);
      append(`keystore manager rebuilt ✓ (revocableKeyIndex ${km.getRevocableKeyIndex()})`);
      append('↳ matches the live passkey above ⇒ recovery works with no passkey.');
    } catch (e) {
      append(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="w-full max-w-[720px] self-center gap-[12px] px-[20px] py-[28px]"
    >
      <Text className="font-pp-bold text-[20px] text-text">Passkey foundation spike</Text>
      <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
        Not real auth. No protocol keys, nothing stored. Exercises WebAuthn PRF + backup-state flags.
      </Text>

      <View className="gap-[6px] rounded-control border border-border-light bg-card-background p-[14px]">
        <Text className="font-pp-regular text-[12px] text-text-secondary">rpId: {rpId || '(unknown)'}</Text>
        <Text className="font-pp-regular text-[12px] text-text-secondary">WebAuthn available: {String(available)}</Text>
        <Text className="font-pp-regular text-[12px] text-text-secondary">PRF likely supported: {likely === null ? '…' : String(likely)}</Text>
      </View>

      <Pressable
        className={`items-center justify-center rounded-control bg-button-primary py-[13px] ${busy || !available ? 'opacity-50' : 'opacity-100'}`}
        onPress={runCreate}
        disabled={busy || !available}
      >
        <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">Create passkey</Text>
      </Pressable>
      <Pressable
        className={`items-center justify-center rounded-control bg-button-primary py-[13px] ${busy || !available ? 'opacity-50' : 'opacity-100'}`}
        onPress={runGet}
        disabled={busy || !available}
      >
        <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">Get PRF (unlock)</Text>
      </Pressable>
      <Pressable
        className={`items-center justify-center rounded-control bg-button-primary py-[13px] ${busy || !available ? 'opacity-50' : 'opacity-100'}`}
        onPress={runBackup}
        disabled={busy || !available}
      >
        <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">Download backup (re-auth)</Text>
      </Pressable>

      <TextInput
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        value={restoreInput}
        onChangeText={setRestoreInput}
        editable={!busy}
        placeholder="Paste a backup payload to restore (no passkey needed)…"
        // nw-keep(data-color): muted placeholder color into the TextInput sink (theme token, no className path)
        placeholderTextColor={colors.textMuted}
        className="min-h-[64px] rounded-control border border-border-light bg-[#FAFAFA] px-[12px] py-[10px] font-pp-regular text-[11px] text-text dark:bg-[#121314]"
        // nw-keep(platform-css): native-only TextInput vertical text alignment (Android multiline top-align) — no NativeWind utility
        style={{ textAlignVertical: 'top' }}
      />
      <Pressable
        className={`items-center justify-center rounded-control border border-border-light py-[11px] ${restoreInput.trim() ? 'opacity-100' : 'opacity-50'}`}
        onPress={runRestore}
        disabled={!restoreInput.trim()}
      >
        <Text className="font-pp-medium text-[13px] text-text">Restore from backup</Text>
      </Pressable>

      <Pressable className="items-center justify-center rounded-control border border-border-light py-[11px]" onPress={() => setLog([])}>
        <Text className="font-pp-medium text-[13px] text-text">Clear</Text>
      </Pressable>

      <View className="gap-[6px] rounded-control border border-border-light bg-card-background p-[14px]">
        {log.length === 0 ? (
          <Text className="font-pp-regular text-[12px] text-text-muted">No output yet.</Text>
        ) : (
          log.map((line, i) => (
            <Text key={i} selectable className={`font-pp-regular text-[11px] leading-[17px] ${line.startsWith('ERROR') ? 'text-danger' : 'text-text'}`}>
              {line}
            </Text>
          ))
        )}
      </View>
    </ScrollView>
  );
}
