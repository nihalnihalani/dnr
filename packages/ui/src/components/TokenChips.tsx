import { useState } from 'react';

const LIMIT = 48;

/**
 * A and R token chips, marked + and −. `hitA`/`hitR` flag tokens matched by the proposal
 * (multiset intersection), shown with an outline and a "matched" text for screen readers.
 */
export function TokenChips({
  A,
  R,
  hitA,
  hitR,
}: {
  A: string[];
  R: string[];
  hitA?: boolean[];
  hitR?: boolean[];
}) {
  const [all, setAll] = useState(false);
  const show = (xs: string[]) => (all ? xs : xs.slice(0, LIMIT));
  const more = Math.max(A.length, R.length) > LIMIT;
  const nA = hitA?.filter(Boolean).length;
  const nR = hitR?.filter(Boolean).length;
  return (
    <div>
      <p style={{ margin: '6px 0 0', fontSize: '0.85rem' }}>
        A (added by C): {A.length} tokens{nA !== undefined ? `, ${nA} matched` : ''} · R (removed by C):{' '}
        {R.length} tokens
        {nR !== undefined ? `, ${nR} matched` : ''}
      </p>
      <ul className="chips" aria-label="Added tokens (A)" style={{ listStyle: 'none', padding: 0 }}>
        {show(A).map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: token positions are the identity
          <li key={i} className={`chip add${hitA?.[i] ? ' hit' : ''}`} title={t}>
            <span className="sign" aria-hidden="true">
              +
            </span>
            <span className="sr-only">added{hitA?.[i] ? ', matched' : ''}: </span>
            {t}
          </li>
        ))}
      </ul>
      {R.length > 0 && (
        <ul className="chips" aria-label="Removed tokens (R)" style={{ listStyle: 'none', padding: 0 }}>
          {show(R).map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: token positions are the identity
            <li key={i} className={`chip rem${hitR?.[i] ? ' hit' : ''}`} title={t}>
              <span className="sign" aria-hidden="true">
                −
              </span>
              <span className="sr-only">removed{hitR?.[i] ? ', matched' : ''}: </span>
              {t}
            </li>
          ))}
        </ul>
      )}
      {more && (
        <button type="button" className="btn" onClick={() => setAll((x) => !x)} aria-expanded={all}>
          {all ? 'Show fewer tokens' : 'Show all tokens'}
        </button>
      )}
    </div>
  );
}
