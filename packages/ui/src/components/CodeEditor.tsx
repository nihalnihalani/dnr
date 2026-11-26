/** CodeMirror 6 editor (loaded as its own chunk). */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

/** High-contrast syntax colors for the dark editor (every color ≥ 7:1 on #0a0c10). */
const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword],
    color: '#c9b3ff',
  },
  { tag: [t.string, t.special(t.string), t.docString], color: '#a8e6b8' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#b4bccb', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#ffc58a' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)],
    color: '#9fd3ff',
  },
  { tag: [t.className, t.typeName, t.namespace], color: '#ffd98a' },
  { tag: [t.propertyName, t.attributeName], color: '#e8e4da' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: '#d6dae3' },
  { tag: [t.self, t.variableName], color: '#e8e4da' },
  { tag: t.invalid, color: '#ffb4ab' },
]);

const theme = EditorView.theme(
  {
    '&': { backgroundColor: '#0a0c10', color: '#e8e4da' },
    '.cm-content': { caretColor: '#ffd479' },
    '.cm-gutters': { backgroundColor: '#11141b', color: '#8f97a8', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#151a24' },
    '.cm-activeLineGutter': { backgroundColor: '#1a2030', color: '#e8e4da' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#2b3a5a !important',
    },
    '&.cm-focused': { outline: '3px solid #ffd479', outlineOffset: '-3px' },
  },
  { dark: true },
);

export default function CodeEditor({
  value,
  onChange,
  lang,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  lang: 'python' | 'ts';
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef(onChange);
  const language = useRef(new Compartment()).current;
  cb.current = onChange;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once per language
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          theme,
          syntaxHighlighting(highlight, { fallback: false }),
          language.of([]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    // The scroller is keyboard-reachable so long files scroll without a mouse (axe scrollable-region-focusable).
    v.scrollDOM.tabIndex = 0;
    v.scrollDOM.setAttribute('aria-label', `${label} (scroll area)`);
    // Language support is its own chunk: a Python case never downloads the JS/TS grammar.
    const load =
      lang === 'python'
        ? import('@codemirror/lang-python').then((m) => m.python())
        : import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true }));
    load.then((ext) => {
      if (view.current === v) v.dispatch({ effects: language.reconfigure(ext) });
    });
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [lang, label]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} data-testid="editor" />;
}
