import { useId, useRef, useState } from 'react';
import { FileUpIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Keyboard-accessible drop zone + file input (spec §7.3). Reads the file as text in the browser
 * and enforces the size cap before anything is sent.
 */
export function FileDrop({ accept, maxBytes, file, onFile, onError }: { accept: string; maxBytes: number; file: { name: string; content: string } | null; onFile: (f: { name: string; content: string } | null) => void; onError: (msg: string | null) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [size, setSize] = useState<number | null>(null);
  const read = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > maxBytes) {
      onError(`${f.name} is ${formatBytes(f.size)}. The limit is ${formatBytes(maxBytes)}.`);
      return;
    }
    onError(null);
    setSize(f.size);
    onFile({ name: f.name, content: await f.text() });
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void read(e.dataTransfer.files[0]);
        }}
        className={cn('flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center', over ? 'border-primary bg-brand-muted' : 'border-border')}
      >
        <FileUpIcon aria-hidden="true" className="size-6 text-muted-foreground" />
        <span className="text-[13.5px]">Drop a spec file here, or</span>
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
          Choose a file
        </Button>
        <label htmlFor={id} className="sr-only">
          Spec file
        </label>
        <input id={id} ref={input} type="file" accept={accept} className="sr-only" onChange={(e) => void read(e.target.files?.[0])} />
        <span className="text-xs text-muted-foreground">{accept.replaceAll(',', ' ')} · up to {formatBytes(maxBytes)}</span>
      </div>
      {file ? (
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[13.5px]">
          <span className="font-mono">{file.name}</span>
          {size !== null ? <span className="text-muted-foreground">{formatBytes(size)}</span> : null}
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${file.name}`} onClick={() => onFile(null)}>
            <XIcon />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
