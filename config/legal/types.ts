/** A run of text with the source document's inline formatting (1 = on). */
export type LegalRun = { t: string; b?: number; i?: number; u?: number };

export type LegalBlock = {
  runs: LegalRun[];
  /** A section heading in the source document. */
  heading?: boolean;
  /** Set when the paragraph is an auto-numbered list item in the source. */
  list?: 'bullet' | 'letter';
  level?: number;
};

export type LegalDocument = {
  title: string;
  /** The "Last Updated" line of the source document, verbatim. */
  lastUpdated: string;
  blocks: LegalBlock[];
};
