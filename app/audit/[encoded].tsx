import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { AuditVerifyView } from '@/components/audit-verify-view';

export default function AuditEncodedScreen() {
  const params = useLocalSearchParams<{ encoded?: string | string[] }>();
  const encoded = Array.isArray(params.encoded) ? params.encoded[0] : params.encoded;
  return <AuditVerifyView initialEncoded={encoded} />;
}
