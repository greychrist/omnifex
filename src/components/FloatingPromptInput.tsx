import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Maximize2,
  Minimize2,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { FilePicker } from "./FilePicker";
import { SlashCommandPicker } from "./SlashCommandPicker";
import { ImagePreview } from "./ImagePreview";
import { type FileEntry, type SlashCommand } from "@/lib/api";

// Sub-components
import type { EffortLevel, ThinkingConfig, PermissionMode } from "./ControlBar";
import {
  extractImagePaths,
  handleImagePaste,
  removeImageFromPrompt,
  useImageDropZone,
} from "./ImageAttachments";
import { useSlashCommandAutocomplete } from "@/hooks/useSlashCommandAutocomplete";

// Re-export types so existing consumers don't break. The model / effort /
// permission pickers themselves moved to the SessionCard context popover.
export type { EffortLevel, ThinkingConfig, PermissionMode };

interface FloatingPromptInputProps {
  onSend: (prompt: string, model: string, images?: string[]) => void;
  isLoading?: boolean;
  disabled?: boolean;
  defaultModel?: string;
  projectPath?: string;
  className?: string;
  onCancel?: () => void;
  extraMenuItems?: React.ReactNode;
  /**
   * Chat ↔ Terminal mode toggle, stacked with `outputStyleToggle` in the
   * left-side column. Renders nothing when omitted.
   */
  modeToggle?: React.ReactNode;
  /**
   * Compact ↔ Verbose output toggle, stacked beneath `modeToggle` in the
   * left-side column at equal width.
   */
  outputStyleToggle?: React.ReactNode;
  configDir?: string;
  tabId?: string;
  /** Pre-fetched built-in CLI slash commands (loaded during session init). */
  supportedCommands?: import("@/lib/api").SessionSlashCommand[];
}

export interface FloatingPromptInputRef {
  addImage: (imagePath: string) => void;
}

const FloatingPromptInputInner = (
  {
    onSend,
    isLoading = false,
    disabled = false,
    defaultModel = "sonnet",
    projectPath,
    className,
    onCancel,
    extraMenuItems,
    modeToggle,
    outputStyleToggle,
    configDir,
    tabId,
    supportedCommands,
  }: FloatingPromptInputProps,
  ref: React.Ref<FloatingPromptInputRef>,
) => {
  const [prompt, setPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>(defaultModel);

  useEffect(() => {
    setSelectedModel(defaultModel);
  }, [defaultModel]);

  const [isExpanded, setIsExpanded] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [filePickerQuery, setFilePickerQuery] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [embeddedImages, setEmbeddedImages] = useState<string[]>([]);
  const [pastedImages, setPastedImages] = useState<string[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const expandedTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [textareaHeight, setTextareaHeight] = useState<number>(72);
  const isIMEComposingRef = useRef(false);

  // -- Slash command autocomplete hook --
  const slash = useSlashCommandAutocomplete();

  // -- Image drop zone hook --
  // Dropped images flow through the same base64 state as pasted ones.
  const handleImageDropped = React.useCallback((dataUrl: string) => {
    setPastedImages(prev => [...prev, dataUrl]);
  }, []);
  const { dragActive } = useImageDropZone(handleImageDropped);

  // Expose addImage via ref
  React.useImperativeHandle(
    ref,
    () => ({
      addImage: (imagePath: string) => {
        setPrompt(currentPrompt => {
          const existingPaths = extractImagePaths(currentPrompt, projectPath);
          if (existingPaths.includes(imagePath)) {
            return currentPrompt;
          }

          const mention = imagePath.includes(' ') ? `@"${imagePath}"` : `@${imagePath}`;
          const newPrompt = currentPrompt + (currentPrompt.endsWith(' ') || currentPrompt === '' ? '' : ' ') + mention + ' ';

          setTimeout(() => {
            const target = isExpanded ? expandedTextareaRef.current : textareaRef.current;
            target?.focus();
            target?.setSelectionRange(newPrompt.length, newPrompt.length);
          }, 0);

          return newPrompt;
        });
      }
    }),
    [isExpanded, projectPath]
  );

  // Update embedded images when prompt changes + auto-resize
  useEffect(() => {
    const imagePaths = extractImagePaths(prompt, projectPath);
    setEmbeddedImages(imagePaths);

    if (textareaRef.current && !isExpanded) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      const newHeight = Math.min(Math.max(scrollHeight, 72), 240);
      setTextareaHeight(newHeight);
      textareaRef.current.style.height = `${newHeight}px`;
    }
  }, [prompt, projectPath, isExpanded]);

  // Focus textarea when expand state changes
  useEffect(() => {
    if (isExpanded && expandedTextareaRef.current) {
      expandedTextareaRef.current.focus();
    } else if (!isExpanded && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isExpanded]);

  // -- Text change handler --
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const newCursorPosition = e.target.selectionStart || 0;

    // Auto-resize
    if (textareaRef.current && !isExpanded) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      const newHeight = Math.min(Math.max(scrollHeight, 72), 240);
      setTextareaHeight(newHeight);
      textareaRef.current.style.height = `${newHeight}px`;
    }

    // Slash command detection (delegated to hook)
    slash.handleTextChangeForSlash(newValue, newCursorPosition, prompt);

    // File picker @ detection
    if (projectPath?.trim() && newValue.length > prompt.length && newValue[newCursorPosition - 1] === '@') {
      console.log('[FloatingPromptInput] @ detected, projectPath:', projectPath);
      setShowFilePicker(true);
      setFilePickerQuery("");
      setCursorPosition(newCursorPosition);
    }

    // Update file picker query while typing after @
    if (showFilePicker && newCursorPosition >= cursorPosition) {
      let atPosition = -1;
      for (let i = newCursorPosition - 1; i >= 0; i--) {
        if (newValue[i] === '@') {
          atPosition = i;
          break;
        }
        if (newValue[i] === ' ' || newValue[i] === '\n') {
          break;
        }
      }

      if (atPosition !== -1) {
        const query = newValue.substring(atPosition + 1, newCursorPosition);
        setFilePickerQuery(query);
      } else {
        setShowFilePicker(false);
        setFilePickerQuery("");
      }
    }

    setPrompt(newValue);
    setCursorPosition(newCursorPosition);
  };

  // -- File selection --
  const handleFileSelect = (entry: FileEntry) => {
    if (textareaRef.current) {
      let atPosition = -1;
      for (let i = cursorPosition - 1; i >= 0; i--) {
        if (prompt[i] === '@') {
          atPosition = i;
          break;
        }
        if (prompt[i] === ' ' || prompt[i] === '\n') {
          break;
        }
      }

      if (atPosition === -1) {
        console.error('[FloatingPromptInput] @ position not found');
        return;
      }

      const textarea = textareaRef.current;
      const beforeAt = prompt.substring(0, atPosition);
      const afterCursor = prompt.substring(cursorPosition);
      const relativePath = entry.path.startsWith(projectPath || '')
        ? entry.path.slice((projectPath || '').length + 1)
        : entry.path;

      const newPrompt = `${beforeAt}@${relativePath} ${afterCursor}`;
      setPrompt(newPrompt);
      setShowFilePicker(false);
      setFilePickerQuery("");

      setTimeout(() => {
        textarea.focus();
        const newCursorPos = beforeAt.length + relativePath.length + 2;
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);
    }
  };

  const handleFilePickerClose = () => {
    setShowFilePicker(false);
    setFilePickerQuery("");
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  };

  // -- IME handling --
  const handleCompositionStart = () => {
    isIMEComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    setTimeout(() => {
      isIMEComposingRef.current = false;
    }, 0);
  };

  const isIMEInteraction = (event?: React.KeyboardEvent) => {
    if (isIMEComposingRef.current) return true;
    if (!event) return false;
    const nativeEvent = event.nativeEvent;
    if (nativeEvent.isComposing) return true;
    const key = nativeEvent.key;
    if (key === 'Process' || key === 'Unidentified') return true;
    const keyboardEvent = nativeEvent;
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional IME composition detection; keyCode 229 is the only reliable signal across browsers.
    const keyCode = keyboardEvent.keyCode ?? (keyboardEvent as unknown as { which?: number }).which;
    if (keyCode === 229) return true;
    return false;
  };

  // -- Send / key handling --
  const handleSend = () => {
    if (isIMEInteraction()) return;

    if ((prompt.trim() || pastedImages.length > 0) && !disabled) {
      const finalPrompt = prompt.trim();
      onSend(finalPrompt, selectedModel, pastedImages.length > 0 ? pastedImages : undefined);
      setPrompt("");
      setEmbeddedImages([]);
      setPastedImages([]);
      setTextareaHeight(48);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showFilePicker && e.key === 'Escape') {
      e.preventDefault();
      setShowFilePicker(false);
      setFilePickerQuery("");
      return;
    }

    if (slash.showSlashCommandPicker && e.key === 'Escape') {
      e.preventDefault();
      const textarea = isExpanded ? expandedTextareaRef.current : textareaRef.current;
      slash.handleSlashCommandPickerClose(textarea);
      return;
    }

    if (e.key === 'e' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      setIsExpanded(true);
      return;
    }

    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !isExpanded &&
      !showFilePicker &&
      !slash.showSlashCommandPicker
    ) {
      if (isIMEInteraction(e)) return;
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    handleImagePaste(e, (dataUrl) => {
      setPastedImages(prev => [...prev, dataUrl]);
    });
  };

  // Browser drag-and-drop passthrough (visual only; real handling in useImageDropZone)
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // -- Image removal --
  const handleRemoveImage = (index: number) => {
    const newPrompt = removeImageFromPrompt(prompt, embeddedImages, index, projectPath);
    setPrompt(newPrompt);
  };

  // Active textarea helper
  const activeTextarea = () => isExpanded ? expandedTextareaRef.current : textareaRef.current;

  return (
    <TooltipProvider>
    <>
      {/* Expanded Modal */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm"
            onClick={() => { setIsExpanded(false); }}
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.15 }}
              className="bg-background border border-border rounded-lg shadow-lg w-full max-w-2xl p-4 space-y-4"
              onClick={(e) => { e.stopPropagation(); }}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Compose your prompt</h3>
                <TooltipSimple content="Minimize" side="bottom">
                  <motion.div
                    whileTap={{ scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => { setIsExpanded(false); }}
                      className="h-8 w-8"
                    >
                      <Minimize2 className="h-4 w-4" />
                    </Button>
                  </motion.div>
                </TooltipSimple>
              </div>

              {/* Image previews in expanded mode */}
              {embeddedImages.length > 0 && (
                <ImagePreview
                  images={embeddedImages}
                  onRemove={handleRemoveImage}
                  className="border-t border-border pt-2"
                />
              )}

              <Textarea
                ref={expandedTextareaRef}
                value={prompt}
                onChange={handleTextChange}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onPaste={handlePaste}
                placeholder="Type your message..."
                className="min-h-[200px] resize-none"
                disabled={disabled}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
              />

              <div className="flex items-center justify-end">
                <TooltipSimple content="Send message" side="top">
                  <motion.div
                    whileTap={{ scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                  >
                    <Button
                      onClick={handleSend}
                      disabled={!prompt.trim() || disabled}
                      size="default"
                      className="min-w-[60px]"
                    >
                      {isLoading ? (
                        <div className="rotating-symbol text-primary-foreground" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </motion.div>
                </TooltipSimple>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fixed Position Input Bar */}
      <div
        className={cn(
          "bg-muted border-t border-border shadow-lg",
          dragActive && "ring-2 ring-primary ring-offset-2",
          className
        )}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <div className="container mx-auto">
          {/* Image previews */}
          {embeddedImages.length > 0 && (
            <ImagePreview
              images={embeddedImages}
              onRemove={handleRemoveImage}
              className="border-b border-border"
            />
          )}
          {pastedImages.length > 0 && (
            <ImagePreview
              images={pastedImages}
              onRemove={(index) => { setPastedImages(prev => prev.filter((_, i) => i !== index)); }}
              className="border-b border-border"
            />
          )}

          <div className="p-3">
            <div className="flex items-end gap-2">
              {/* Left side: mode + output toggles stacked vertically at equal
                  widths. The model/effort/permission pickers live in the
                  SessionCard context popover. */}
              {(modeToggle || outputStyleToggle) && (
                <div className="flex flex-col items-stretch gap-1.5 shrink-0 mb-1 w-52">
                  {modeToggle}
                  {outputStyleToggle}
                </div>
              )}

              {/* Prompt Input - Center */}
              <div className="flex-1 relative">
                <Textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={handleTextChange}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={handleCompositionStart}
                  onCompositionEnd={handleCompositionEnd}
                  onPaste={handlePaste}
                  placeholder={
                    dragActive
                      ? "Drop images here..."
                      : "Message Claude (@ for files, / for commands)..."
                  }
                  disabled={disabled}
                  className={cn(
                    "resize-none pr-20 pl-3 py-2.5 transition-all duration-150",
                    dragActive && "border-primary",
                    textareaHeight >= 240 && "overflow-y-auto scrollbar-thin"
                  )}
                  style={{
                    height: `${textareaHeight}px`,
                    overflowY: textareaHeight >= 240 ? 'auto' : 'hidden'
                  }}
                />

                {/* Action buttons inside input */}
                <div className="absolute right-1.5 bottom-1.5 flex items-center gap-0.5">
                  <TooltipSimple content="Expand (Ctrl+Shift+E)" side="top">
                    <motion.div
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => { setIsExpanded(true); }}
                        disabled={disabled}
                        className="h-8 w-8 hover:bg-accent/50 transition-colors"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                      </Button>
                    </motion.div>
                  </TooltipSimple>

                  <TooltipSimple content={isLoading ? "Stop generation" : "Send message (Enter)"} side="top">
                    <motion.div
                      whileTap={{ scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                    >
                      <Button
                        onClick={isLoading ? onCancel : handleSend}
                        disabled={isLoading ? false : (!prompt.trim() || disabled)}
                        variant={isLoading ? "destructive" : prompt.trim() ? "default" : "ghost"}
                        size="icon"
                        className={cn(
                          "h-8 w-8 transition-all",
                          prompt.trim() && !isLoading && "shadow-sm"
                        )}
                      >
                        {isLoading ? (
                          <Square className="h-4 w-4" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                      </Button>
                    </motion.div>
                  </TooltipSimple>
                </div>

                {/* File Picker */}
                <AnimatePresence>
                  {showFilePicker && projectPath?.trim() && (
                    <FilePicker
                      basePath={projectPath.trim()}
                      onSelect={handleFileSelect}
                      onClose={handleFilePickerClose}
                      initialQuery={filePickerQuery}
                    />
                  )}
                </AnimatePresence>

                {/* Slash Command Picker */}
                <AnimatePresence>
                  {slash.showSlashCommandPicker && (
                    <SlashCommandPicker
                      projectPath={projectPath}
                      tabId={tabId}
                      prefetchedCommands={supportedCommands}
                      onSelect={(cmd: SlashCommand) =>
                        { slash.handleSlashCommandSelect(cmd, prompt, cursorPosition, setPrompt, activeTextarea()); }
                      }
                      onClose={() => { slash.handleSlashCommandPickerClose(activeTextarea()); }}
                      initialQuery={slash.slashCommandQuery}
                      configDir={configDir}
                    />
                  )}
                </AnimatePresence>
              </div>

              {/* Right side: the extra menu items in a 2×2 square */}
              {extraMenuItems && (
                <div className="grid grid-cols-2 gap-0.5 shrink-0 mb-1">
                  {extraMenuItems}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
    </TooltipProvider>
  );
};

export const FloatingPromptInput = React.forwardRef<
  FloatingPromptInputRef,
  FloatingPromptInputProps
>(FloatingPromptInputInner);

FloatingPromptInput.displayName = 'FloatingPromptInput';
