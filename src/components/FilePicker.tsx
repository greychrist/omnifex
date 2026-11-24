import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { api } from "@/lib/api";
import { 
  X, 
  Folder, 
  File, 
  FileCode,
  FileText,
  FileImage,
  Search,
  ChevronRight
} from "lucide-react";
import type { FileEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { logAndForget } from "@/lib/fireAndLog";

const globalDirectoryCache = new Map<string, FileEntry[]>();
const globalSearchCache = new Map<string, FileEntry[]>();

interface FilePickerProps {
  basePath: string;
  onSelect: (entry: FileEntry) => void;
  onClose: () => void;
  initialQuery?: string;
  className?: string;
}

const getFileIcon = (entry: FileEntry) => {
  if (entry.is_directory) return Folder;
  
  const ext = entry.extension?.toLowerCase();
  if (!ext) return File;
  
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h'].includes(ext)) {
    return FileCode;
  }
  
  if (['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css'].includes(ext)) {
    return FileText;
  }
  
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    return FileImage;
  }
  
  return File;
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

export const FilePicker: React.FC<FilePickerProps> = ({
  basePath,
  onSelect,
  onClose,
  initialQuery = "",
  className,
}) => {
  const searchQuery = initialQuery;
  
  const [currentPath, setCurrentPath] = useState(basePath);
  const [entries, setEntries] = useState<FileEntry[]>(() => 
    searchQuery.trim() ? [] : globalDirectoryCache.get(basePath) || []
  );
  const [searchResults, setSearchResults] = useState<FileEntry[]>(() => {
    if (searchQuery.trim()) {
      const cacheKey = `${basePath}:${searchQuery}`;
      return globalSearchCache.get(cacheKey) || [];
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathHistory, setPathHistory] = useState<string[]>([basePath]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isShowingCached, setIsShowingCached] = useState(() => {
    if (searchQuery.trim()) {
      const cacheKey = `${basePath}:${searchQuery}`;
      return globalSearchCache.has(cacheKey);
    }
    return globalDirectoryCache.has(basePath);
  });
  
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  
  const displayEntries = searchQuery.trim() ? searchResults : entries;
  const canGoBack = pathHistory.length > 1;
  
  const relativePath = currentPath.startsWith(basePath)
    ? currentPath.slice(basePath.length) || '/'
    : currentPath;

  const loadDirectory = useCallback(async (path: string) => {
    try {
      console.log('[FilePicker] Loading directory:', path);

      if (globalDirectoryCache.has(path)) {
        console.log('[FilePicker] Showing cached contents for:', path);
        setEntries(globalDirectoryCache.get(path) || []);
        setIsShowingCached(true);
        setError(null);
      } else {
        setIsLoading(true);
      }

      const contents = await api.listDirectoryContents(path);
      console.log('[FilePicker] Loaded fresh contents:', contents.length, 'items');

      globalDirectoryCache.set(path, contents);

      setEntries(contents);
      setIsShowingCached(false);
      setError(null);
    } catch (err) {
      console.error('[FilePicker] Failed to load directory:', path, err);
      console.error('[FilePicker] Error details:', err);
      if (!globalDirectoryCache.has(path)) {
        setError(err instanceof Error ? err.message : 'Failed to load directory');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const performSearch = useCallback(async (query: string) => {
    try {
      console.log('[FilePicker] Searching for:', query, 'in:', basePath);

      const cacheKey = `${basePath}:${query}`;

      if (globalSearchCache.has(cacheKey)) {
        console.log('[FilePicker] Showing cached search results for:', query);
        setSearchResults(globalSearchCache.get(cacheKey) || []);
        setIsShowingCached(true);
        setError(null);
      } else {
        setIsLoading(true);
      }

      const results = await api.searchFiles(basePath, query);
      console.log('[FilePicker] Fresh search results:', results.length, 'items');

      globalSearchCache.set(cacheKey, results);

      setSearchResults(results);
      setIsShowingCached(false);
      setError(null);
    } catch (err) {
      console.error('[FilePicker] Search failed:', query, err);
      const cacheKey = `${basePath}:${query}`;
      if (!globalSearchCache.has(cacheKey)) {
        setError(err instanceof Error ? err.message : 'Search failed');
      }
    } finally {
      setIsLoading(false);
    }
  }, [basePath]);

  const navigateToDirectory = useCallback((path: string) => {
    setCurrentPath(path);
    setPathHistory(prev => [...prev, path]);
  }, []);

  const navigateBack = useCallback(() => {
    if (pathHistory.length > 1) {
      const newHistory = [...pathHistory];
      newHistory.pop();
      const previousPath = newHistory[newHistory.length - 1];

      if (previousPath.startsWith(basePath) || previousPath === basePath) {
        setCurrentPath(previousPath);
        setPathHistory(newHistory);
      }
    }
  }, [pathHistory, basePath]);

  useEffect(() => {
    logAndForget('file-picker:load-directory', loadDirectory(currentPath));
  }, [currentPath, loadDirectory]);

  useEffect(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

    if (searchQuery.trim()) {
      const cacheKey = `${basePath}:${searchQuery}`;
      
      if (globalSearchCache.has(cacheKey)) {
        console.log('[FilePicker] Immediately showing cached search results for:', searchQuery);
        setSearchResults(globalSearchCache.get(cacheKey) || []);
        setIsShowingCached(true);
        setError(null);
      }
      
      searchDebounceRef.current = setTimeout(() => {
        logAndForget('file-picker:perform-search', performSearch(searchQuery));
      }, 300);
    } else {
      setSearchResults([]);
      setIsShowingCached(false);
    }

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [searchQuery, basePath, performSearch]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [entries, searchResults]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const displayEntries = searchQuery.trim() ? searchResults : entries;
      
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
          
        case 'Enter':
          e.preventDefault();
          if (displayEntries.length > 0 && selectedIndex < displayEntries.length) {
            onSelect(displayEntries[selectedIndex]);
          }
          break;
          
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(0, prev - 1));
          break;
          
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(displayEntries.length - 1, prev + 1));
          break;
          
        case 'ArrowRight':
          e.preventDefault();
          if (displayEntries.length > 0 && selectedIndex < displayEntries.length) {
            const entry = displayEntries[selectedIndex];
            if (entry.is_directory) {
              navigateToDirectory(entry.path);
            }
          }
          break;
          
        case 'ArrowLeft':
          e.preventDefault();
          if (canGoBack) {
            navigateBack();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); };
  }, [entries, searchResults, selectedIndex, searchQuery, canGoBack, navigateBack, navigateToDirectory, onClose, onSelect]);

  useEffect(() => {
    if (fileListRef.current) {
      const selectedElement = fileListRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [selectedIndex]);

  const handleEntryClick = (entry: FileEntry) => {
    onSelect(entry);
  };
  
  const handleEntryDoubleClick = (entry: FileEntry) => {
    if (entry.is_directory) {
      navigateToDirectory(entry.path);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={cn(
        "absolute bottom-full mb-2 left-0 z-50",
        "w-[500px] h-[400px]",
        "bg-background border border-border rounded-lg shadow-lg",
        "flex flex-col overflow-hidden",
        className
      )}
    >
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BackButton
              label="Up one folder"
              size="md"
              onClick={navigateBack}
              disabled={!canGoBack}
            />
            <span className="text-sm font-mono text-muted-foreground truncate max-w-[300px]">
              {relativePath}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto relative">
        {isLoading && displayEntries.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        )}

        {isShowingCached && isLoading && displayEntries.length > 0 && (
          <div className="absolute top-1 right-2 text-xs text-muted-foreground/50 italic">
            updating...
          </div>
        )}

        {error && displayEntries.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-destructive">{error}</span>
          </div>
        )}

        {!isLoading && !error && displayEntries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full">
            <Search className="h-8 w-8 text-muted-foreground mb-2" />
            <span className="text-sm text-muted-foreground">
              {searchQuery.trim() ? 'No files found' : 'Empty directory'}
            </span>
          </div>
        )}

        {displayEntries.length > 0 && (
          <div className="p-2 space-y-0.5" ref={fileListRef}>
            {displayEntries.map((entry, index) => {
              const Icon = getFileIcon(entry);
              const isSearching = searchQuery.trim() !== '';
              const isSelected = index === selectedIndex;
              
              return (
                <button
                  key={entry.path}
                  data-index={index}
                  onClick={() => { handleEntryClick(entry); }}
                  onDoubleClick={() => { handleEntryDoubleClick(entry); }}
                  onMouseEnter={() => { setSelectedIndex(index); }}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md",
                    "hover:bg-accent transition-colors",
                    "text-left text-sm",
                    isSelected && "bg-accent"
                  )}
                  title={entry.is_directory ? "Click to select • Double-click to enter" : "Click to select"}
                >
                  <Icon className={cn(
                    "h-4 w-4 flex-shrink-0",
                    entry.is_directory ? "text-blue-500" : "text-muted-foreground"
                  )} />
                  
                  <span className="flex-1 truncate">
                    {entry.name}
                  </span>
                  
                  {!entry.is_directory && entry.size > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {formatFileSize(entry.size)}
                    </span>
                  )}
                  
                  {entry.is_directory && (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  
                  {isSearching && (
                    <span className="text-xs text-muted-foreground font-mono truncate max-w-[150px]">
                      {entry.path.replace(basePath, '').replace(/^\//, '')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border p-2">
        <p className="text-xs text-muted-foreground text-center">
          ↑↓ Navigate • Enter Select • → Enter Directory • ← Go Back • Esc Close
        </p>
      </div>
    </motion.div>
  );
}; 