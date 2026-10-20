import { LegalDocumentView } from '@/components/legal/legal-document-view';
import { TERMS_OF_USE } from '@/config/legal/terms-of-use';

export default function TermsScreen() {
  return <LegalDocumentView doc={TERMS_OF_USE} />;
}
