import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export type CodeLang = 'python' | 'yaml' | 'graphql' | 'json';

type Token = { content: string; htmlStyle?: Record<string, string> };
type Highlighter = { codeToTokens: (code: string, opts: { lang: CodeLang; themes: { light: string; dark: string } }) => { tokens: Token[][] } };

let highlighter: Promise<Highlighter> | null = null;

/**
 * Lazy shiki highlighter (A-HIGHLIGHT): core bundle, four grammars, the JavaScript regex engine (no
 * WASM, so the CSP is unchanged). Loaded on first use only, in the chunk that needs it.
 */
function loadHighlighter(): Promise<Highlighter> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    const h = await createHighlighterCore({
      themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
      langs: [import('@shikijs/langs/python'), import('@shikijs/langs/yaml'), import('@shikijs/langs/graphql'), import('@shikijs/langs/json')],
      engine: createJavaScriptRegexEngine(),
    });
    return h as unknown as Highlighter;
  })();
  return highlighter;
}

/**
 * Read-only code block with line numbers and optional highlighted lines (errors). Tokens are
 * rendered as React text spans, never as HTML, so agent-written code cannot inject markup
 * (spec §13). Falls back to plain monospace while shiki loads or if it fails.
 */
export function CodeView({ code, lang, className, highlightLines, label, lineNumbers = true, maxHeight }: { code: string; lang: CodeLang; className?: string; highlightLines?: number[]; label?: string; lineNumbers?: boolean; maxHeight?: number }) {
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  useEffect(() => {
    let alive = true;
    if (import.meta.env.MODE === 'test') return;
    loadHighlighter()
      .then((h) => {
        if (alive) setTokens(h.codeToTokens(code, { lang, themes: { light: 'github-light', dark: 'github-dark' } }).tokens);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, lang]);
  const lines: Token[][] = tokens ?? code.split('\n').map((l) => [{ content: l }]);
  const hl = new Set(highlightLines ?? []);
  return (
    <pre aria-label={label} tabIndex={0} className={cn('overflow-auto rounded-lg border bg-muted/40 py-3 font-mono text-[12.5px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} style={maxHeight ? { maxHeight } : undefined}>
      <code className="block min-w-max">
        {lines.map((line, i) => (
          <span key={i} className={cn('flex px-3.5', hl.has(i + 1) && 'bg-destructive-muted')}>
            {lineNumbers ? (
              <span aria-hidden="true" className="mr-4 inline-block w-6 shrink-0 text-right text-muted-foreground/60 select-none">
                {i + 1}
              </span>
            ) : null}
            <span className="whitespace-pre">
              {line.length ? line.map((t, j) => <span key={j} className="shiki-token" style={t.htmlStyle as React.CSSProperties}>{t.content}</span>) : ' '}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}
