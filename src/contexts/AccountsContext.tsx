import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { api, type Account } from '@/lib/api';
import { logAndForget } from "@/lib/fireAndLog";

interface AccountsContextType {
  accounts: Account[];
  refresh: () => Promise<void>;
  getColor: (name: string) => string | null;
  getIcon: (name: string) => string | null;
  getAccountType: (name: string) => string | null;
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
    logAndForget('accounts-context:refresh', refresh());
  }, [refresh]);

  const getColor = useCallback((name: string): string | null => {
    return accounts.find(a => a.name === name)?.color ?? null;
  }, [accounts]);

  const getIcon = useCallback((name: string): string | null => {
    return accounts.find(a => a.name === name)?.icon ?? null;
  }, [accounts]);

  const getAccountType = useCallback((name: string): string | null => {
    return accounts.find(a => a.name === name)?.subscription_label ?? null;
  }, [accounts]);

  const value = useMemo(
    () => ({ accounts, refresh, getColor, getIcon, getAccountType }),
    [accounts, refresh, getColor, getIcon, getAccountType],
  );

  return (
    <AccountsContext.Provider value={value}>
      {children}
    </AccountsContext.Provider>
  );
};

export function useAccounts() {
  const ctx = useContext(AccountsContext);
  if (!ctx) throw new Error('useAccounts must be used within AccountsProvider');
  return ctx;
}
