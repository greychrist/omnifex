import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { parsePricingOverrides } from '@/lib/pricing';
import { Button } from '@/components/ui/button';

const PLACEHOLDER = `{
  "sonnet-5": { "input": 2, "output": 10 },
  "opus-4-8": { "input": 5, "output": 25, "cacheRead": 0.5 }
}`;

/**
 * Raw-JSON editor for per-model pricing overrides (USD per MTok). Keys are
 * model-id substring patterns; omitted fields derive from the standard
 * formula (cache read 0.1x input, write 1.25x/2x). Used for price drift,
 * intro pricing, or negotiated enterprise rates.
 */
export function PricingOverridesEditor() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'saved' | 'invalid' | 'error'>('idle');

  useEffect(() => {
    void api.getSetting('pricing_overrides').then((v) => {
      if (typeof v === 'string') setText(v);
    }).catch(() => {});
  }, []);

  const save = async () => {
    const trimmed = text.trim();
    if (trimmed && !parsePricingOverrides(trimmed)) {
      setStatus('invalid');
      return;
    }
    try {
      await api.saveSetting('pricing_overrides', trimmed);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Pricing overrides</div>
      <p className="text-xs text-muted-foreground">
        Optional per-model rate overrides in USD per million tokens. Keys are model-id
        substrings (longest match wins). Leave empty to use built-in Anthropic rates.
        Applies to the session cost widget, cost history, and per-message costs on next
        session start / rescan.
      </p>
      <textarea
        className="h-36 w-full rounded border bg-background p-2 font-mono text-xs"
        placeholder={PLACEHOLDER}
        value={text}
        onChange={(e) => { setText(e.target.value); setStatus('idle'); }}
        spellCheck={false}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void save()}>Save</Button>
        {status === 'saved' && <span className="text-xs text-green-400">Saved</span>}
        {status === 'invalid' && <span className="text-xs text-red-400">Not a valid overrides JSON object</span>}
        {status === 'error' && <span className="text-xs text-red-400">Save failed — value not persisted</span>}
      </div>
    </div>
  );
}
