import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, type Account } from '@/lib/api';

interface AccountsContextType {
  accounts: Account[];
  refresh: () => Promise<void>;
  getColor: (name: string) => string | null;
}

const AccountsContext = createContext<AccountsContextType | undefined>(undefined);

export const AccountsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [accounts, setAccounts] = useState<Account[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listAccounts();
      setAccounts(list);
    } catch {
      // silent — accounts may not be available yet
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const getColor = useCallback((name: string): string | null => {
    return accounts.find(a => a.name === name)?.color ?? null;
  }, [accounts]);

  return (
    <AccountsContext.Provider value={{ accounts, refresh, getColor }}>
      {children}
    </AccountsContext.Provider>
  );
};

export function useAccounts() {
  const ctx = useContext(AccountsContext);
  if (!ctx) throw new Error('useAccounts must be used within AccountsProvider');
  return ctx;
}
