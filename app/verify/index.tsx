import React from 'react';
import { AuditVerifyView } from '@/components/audit-verify-view';
import { useShareLinkPayload } from '@/hooks/use-share-link-payload';

export default function VerifyScreen() {
  return <AuditVerifyView initialEncoded={useShareLinkPayload()} />;
}
