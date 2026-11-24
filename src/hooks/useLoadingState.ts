import { useState, useCallback } from 'react';

interface LoadingState<T, A extends unknown[]> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  execute: (...args: A) => Promise<T>;
  reset: () => void;
}

/**
 * Custom hook for managing loading states with error handling
 * Reduces boilerplate code for async operations
 */
export function useLoadingState<T, A extends unknown[] = []>(
  asyncFunction: (...args: A) => Promise<T>
): LoadingState<T, A> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(
    async (...args: A): Promise<T> => {
      try {
        setIsLoading(true);
        setError(null);
        const result = await asyncFunction(...args);
        setData(result);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error('An error occurred');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [asyncFunction]
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return { data, isLoading, error, execute, reset };
}