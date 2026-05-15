// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePagination } from '../usePagination';

afterEach(() => { cleanup(); });

function makeData(n: number) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

describe('usePagination — basics', () => {
  it('returns the first page of size 10 by default', () => {
    const { result } = renderHook(() => usePagination(makeData(25)));
    expect(result.current.currentPage).toBe(1);
    expect(result.current.pageSize).toBe(10);
    expect(result.current.totalItems).toBe(25);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.paginatedData).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('honors custom initialPage / initialPageSize', () => {
    const { result } = renderHook(() =>
      usePagination(makeData(50), { initialPage: 3, initialPageSize: 5 }),
    );
    expect(result.current.currentPage).toBe(3);
    expect(result.current.pageSize).toBe(5);
    expect(result.current.paginatedData).toEqual([11, 12, 13, 14, 15]);
  });

  it('canGoNext / canGoPrevious reflect boundary positions', () => {
    const { result } = renderHook(() =>
      usePagination(makeData(20), { initialPageSize: 10 }),
    );
    expect(result.current.canGoPrevious).toBe(false);
    expect(result.current.canGoNext).toBe(true);

    act(() => { result.current.goToPage(2); });
    expect(result.current.canGoPrevious).toBe(true);
    expect(result.current.canGoNext).toBe(false);
  });
});

describe('usePagination — navigation', () => {
  it('nextPage / previousPage step through pages', () => {
    const { result } = renderHook(() => usePagination(makeData(25)));
    act(() => { result.current.nextPage(); });
    expect(result.current.currentPage).toBe(2);
    act(() => { result.current.nextPage(); });
    expect(result.current.currentPage).toBe(3);
    act(() => { result.current.previousPage(); });
    expect(result.current.currentPage).toBe(2);
  });

  it('clamps goToPage below 1 and above totalPages', () => {
    const { result } = renderHook(() => usePagination(makeData(25)));
    act(() => { result.current.goToPage(-5); });
    expect(result.current.currentPage).toBe(1);
    act(() => { result.current.goToPage(99); });
    expect(result.current.currentPage).toBe(3);
  });

  it('setPageSize resets currentPage to 1', () => {
    const { result } = renderHook(() => usePagination(makeData(100)));
    act(() => { result.current.goToPage(5); });
    expect(result.current.currentPage).toBe(5);
    act(() => { result.current.setPageSize(25); });
    expect(result.current.pageSize).toBe(25);
    expect(result.current.currentPage).toBe(1);
  });
});

describe('usePagination — pageRange (UI buttons)', () => {
  it('returns 1..N when totalPages ≤ 7 (no ellipses)', () => {
    const { result } = renderHook(() =>
      usePagination(makeData(30), { initialPageSize: 5 }),
    );
    expect(result.current.totalPages).toBe(6);
    expect(result.current.pageRange).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('inserts a trailing ellipsis when current page is near the start', () => {
    const { result } = renderHook(() =>
      usePagination(makeData(100), { initialPageSize: 10 }),
    );
    // 10 pages, current = 1: range should be [1, 2, -1, 10].
    expect(result.current.totalPages).toBe(10);
    expect(result.current.pageRange).toEqual([1, 2, -1, 10]);
  });

  it('inserts both ellipses when current page is in the middle', () => {
    const { result } = renderHook(() =>
      usePagination(makeData(100), { initialPageSize: 10, initialPage: 5 }),
    );
    expect(result.current.pageRange).toEqual([1, -1, 4, 5, 6, -1, 10]);
  });

  it('inserts a leading ellipsis when current page is near the end', () => {
    const { result } = renderHook(() =>
      usePagination(makeData(100), { initialPageSize: 10, initialPage: 10 }),
    );
    // currentPage = 10 (last). Range: [1, -1, 9, 10].
    expect(result.current.pageRange).toEqual([1, -1, 9, 10]);
  });
});
