import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TooltipSimple } from "@/components/ui/tooltip-modern";
import type { QueuedPrompt } from "@/lib/sessionStreamEffects";

interface QueuedPromptsPanelProps {
  prompts: QueuedPrompt[];
  /** Badge text for a model id — the picker's label, not the raw catalog's. */
  modelLabel: (model: string) => string;
  onRemove: (id: string) => void;
  onSave: (id: string, prompt: string) => void;
  /** The prompt open for editing, or null. The session holds the queue while
   *  that prompt is at its head, and drains it when this goes back to null. */
  onEditingChange: (id: string | null) => void;
  /** A Stop held the queue: nothing drains until the user picks. */
  held?: boolean;
  /** Release the hold; the queue drains as usual from its head. */
  onResume?: () => void;
  /** Send this one prompt now, leaving the rest held. */
  onSendNow?: (id: string) => void;
}

/**
 * The queued-prompt card over the transcript. Click a prompt's text to edit
 * it in place: Enter or clicking away saves, Shift+Enter is a newline, Escape
 * discards. Saving blank text is a cancel — removal is the ✕ button's job.
 */
export function QueuedPromptsPanel({
  prompts,
  modelLabel,
  onRemove,
  onSave,
  onEditingChange,
  held = false,
  onResume,
  onSendNow,
}: QueuedPromptsPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Read by finish(): Enter closes the textarea and its blur follows, which
  // must not save a second time.
  const editingIdRef = useRef<string | null>(null);

  const setEditing = (id: string | null) => {
    editingIdRef.current = id;
    setEditingId(id);
    onEditingChange(id);
  };

  const startEdit = (item: QueuedPrompt) => {
    setDraft(item.prompt);
    setEditing(item.id);
  };

  const finish = (save: boolean) => {
    const id = editingIdRef.current;
    if (id === null) return;
    const text = draft.trim();
    const original = prompts.find((p) => p.id === id)?.prompt;
    if (save && text && text !== original) onSave(id, text);
    setEditing(null);
  };

  // The prompt under edit can leave the queue (✕, a session clear); the hold
  // on it has to go with it.
  useEffect(() => {
    if (editingId !== null && !prompts.some((p) => p.id === editingId)) {
      setEditing(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setEditing is a plain closure over stable setters and the latest onEditingChange.
  }, [prompts, editingId]);

  return (
    <div className="bg-background/95 backdrop-blur-md border rounded-lg shadow-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Queued Prompts ({prompts.length})
          {held && <span> · held after Stop</span>}
        </div>
        {held && onResume && (
          <Button variant="outline" size="sm" className="ml-auto mr-1 h-6 px-2 text-xs" onClick={onResume}>
            Resume queue
          </Button>
        )}
        <TooltipSimple content={collapsed ? "Expand queue" : "Collapse queue"} side="top">
          <motion.div
            whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.15 }}
          >
            <Button variant="ghost" size="icon" onClick={() => { setCollapsed(prev => !prev); }}>
              {collapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </motion.div>
        </TooltipSimple>
      </div>
      {!collapsed && prompts.map((queuedPrompt, index) => (
        <motion.div
          key={queuedPrompt.id}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15, delay: index * 0.02 }}
          className="flex items-start gap-2 bg-muted/50 rounded-md p-2"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
              <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                {modelLabel(queuedPrompt.model)}
              </span>
            </div>
            {editingId === queuedPrompt.id ? (
              <Textarea
                aria-label={`Edit queued prompt ${index + 1}`}
                autoFocus
                rows={3}
                className="text-sm resize-y"
                value={draft}
                onChange={(e) => { setDraft(e.target.value); }}
                onBlur={() => { finish(true); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    finish(true);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(false);
                  }
                }}
              />
            ) : (
              <p
                className="text-sm line-clamp-2 break-words cursor-text rounded hover:bg-muted"
                title="Click to edit"
                onClick={() => { startEdit(queuedPrompt); }}
              >
                {queuedPrompt.prompt}
              </p>
            )}
          </div>
          {held && onSendNow && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 flex-shrink-0"
              title="Send now"
              aria-label="Send now"
              onClick={() => { onSendNow(queuedPrompt.id); }}
            >
              <Play className="h-3 w-3" />
            </Button>
          )}
          <motion.div
            whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.15 }}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 flex-shrink-0"
              title="Remove from queue"
              onClick={() => { onRemove(queuedPrompt.id); }}
            >
              <X className="h-3 w-3" />
            </Button>
          </motion.div>
        </motion.div>
      ))}
    </div>
  );
}
