import { LegalDocumentView } from '@/components/legal/legal-document-view';
import { PRIVACY_POLICY } from '@/config/legal/privacy-policy';

export default function PrivacyScreen() {
  return <LegalDocumentView doc={PRIVACY_POLICY} />;
}
