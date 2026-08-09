import type { ValidationFindingDto } from '@uae/contracts';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui';

/**
 * One editable grid cell.
 *
 * Behaviour that matters:
 *  - Errors are shown by colour AND by an icon, so the state does not depend on
 *    colour vision.
 *  - The hover tooltip carries the rule code, the message, and the original
 *    spreadsheet coordinate, so a user can find the same cell in their own file.
 *  - Edits commit on blur or Enter, and Escape reverts. Committing on every
 *    keystroke would fire a request per character and revalidate constantly.
 *  - After a successful correction the cell flashes green, which is the only
 *    feedback that distinguishes "saved" from "not yet typed".
 */

interface Props {
  rowId: string;
  lineId?: string;
  field: string;
  value: string;
  type: 'text' | 'number' | 'date' | 'select';
  options?: { value: string; label: string }[];
  findings: ValidationFindingDto[];
  disabled: boolean;
  saving: boolean;
  focused: boolean;
  className?: string;
  onCommit: (value: string) => void;
}

export function EditableCell({
  rowId,
  lineId,
  field,
  value,
  type,
  options,
  findings,
  disabled,
  focused,
  className,
  onCommit,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [justFixed, setJustFixed] = useState(false);
  const previousValue = useRef(value);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

  const blocking = findings.some((f) => f.severity === 'ERROR' || f.severity === 'FATAL');
  const warning = !blocking && findings.length > 0;

  // Flash green when the value changes from outside (i.e. the save came back).
  useEffect(() => {
    if (previousValue.current !== value) {
      previousValue.current = value;
      setDraft(value);
      if (!editing) {
        setJustFixed(true);
        const timer = setTimeout(() => setJustFixed(false), 1200);
        return () => clearTimeout(timer);
      }
    }
    return undefined;
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const cellKey = lineId ? `${rowId}:${lineId}:${field}` : `${rowId}:${field}`;
  const tooltip = findings
    .map((f) => {
      const where = f.cell ? ` (${f.sheet} · cell ${f.cell})` : '';
      return `[${f.ruleCode}]${where}\n${f.message}`;
    })
    .join('\n\n');

  if (editing && !disabled) {
    const shared =
      'w-full rounded border border-brand-500 px-1.5 py-1 text-sm shadow-sm ' +
      'focus:outline-none focus:ring-1 focus:ring-brand-500';

    return (
      <span className={cx(className, 'shrink-0')}>
        {type === 'select' && options ? (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className={shared}
            value={draft}
            onChange={(e) => {
              // A picker has no meaningful "still typing" state, so commit at
              // once rather than making the user click away.
              setDraft(e.target.value);
              setEditing(false);
              if (e.target.value !== value) onCommit(e.target.value);
            }}
            onBlur={cancel}
          >
            <option value="">—</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className={shared}
            type={type === 'date' ? 'date' : 'text'}
            inputMode={type === 'number' ? 'decimal' : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') cancel();
            }}
          />
        )}
      </span>
    );
  }

  const display = (() => {
    if (!value) return '';
    if (type === 'select' && options) {
      // Show the code, not the long label, or the grid becomes unreadable.
      return value;
    }
    return value;
  })();

  return (
    <span
      data-cell={cellKey}
      tabIndex={disabled ? -1 : 0}
      role={disabled ? undefined : 'button'}
      title={tooltip || undefined}
      onDoubleClick={() => !disabled && setEditing(true)}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className={cx(
        className,
        'shrink-0 truncate rounded px-1.5 py-1 outline-none',
        !disabled && 'cursor-text hover:bg-slate-100 focus:ring-2 focus:ring-brand-500',
        blocking && 'cell-error',
        warning && 'cell-warn',
        justFixed && 'cell-fixed',
        focused && 'ring-2 ring-brand-500',
        type === 'number' && 'text-right tabular-nums',
        disabled && 'text-slate-500',
      )}
    >
      {blocking && <span className="mr-1 text-danger-500">⚠</span>}
      {warning && <span className="mr-1 text-warn-500">⚠</span>}
      {display || <span className="text-slate-300">—</span>}
    </span>
  );
}
