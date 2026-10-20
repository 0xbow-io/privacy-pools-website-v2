import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface TxActivityContextValue {
  txPending: boolean;
  beginTx: () => void;
  endTx: () => void;
}

const TxActivityContext = createContext<TxActivityContextValue>({
  txPending: false,
  beginTx: () => {},
  endTx: () => {},
});

export function TxActivityProvider({ children }: { children: ReactNode }) {
  const [txPending, setTxPending] = useState(false);
  const counterRef = useRef(0);

  const beginTx = useCallback(() => {
    counterRef.current += 1;
    if (counterRef.current === 1) setTxPending(true);
  }, []);

  const endTx = useCallback(() => {
    counterRef.current = Math.max(0, counterRef.current - 1);
    if (counterRef.current === 0) setTxPending(false);
  }, []);

  const value = useMemo(() => ({ txPending, beginTx, endTx }), [txPending, beginTx, endTx]);

  return <TxActivityContext.Provider value={value}>{children}</TxActivityContext.Provider>;
}

export function useTxActivity(): TxActivityContextValue {
  return useContext(TxActivityContext);
}
