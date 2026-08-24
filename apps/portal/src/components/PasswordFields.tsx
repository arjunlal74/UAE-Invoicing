import { PASSWORD_RULES, isPasswordAcceptable } from '@uae/contracts';
import { Field, cx, inputClass } from './ui';

/**
 * The password rules, shown while the user types.
 *
 * Rendered from the same PASSWORD_RULES the API validates against, so the
 * checklist cannot drift from the rule that rejects the form. SRS v2.3 §3.2
 * requires the requirements to be stated rather than discovered by rejection.
 */
export function PasswordRequirements({ value }: { value: string }) {
  return (
    <ul className="mt-2 space-y-1">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(value);
        return (
          <li
            key={rule.id}
            className={cx(
              'flex items-start gap-1.5 text-xs',
              // Nothing is red until the user has typed something: an empty
              // form is not a form full of mistakes.
              met ? 'text-ok-700' : value ? 'text-slate-500' : 'text-slate-400',
            )}
          >
            <span aria-hidden="true" className="mt-px font-semibold">
              {met ? '✓' : '○'}
            </span>
            <span>{rule.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A new-password pair with live rule feedback and a confirmation box.
 *
 * Used by every screen that sets a password — invitation acceptance, reset by
 * link, in-session change and the forced rotation modal — because four
 * different renderings of the same policy is four chances to disagree with it.
 */
export function NewPasswordFields({
  password,
  confirmation,
  onPasswordChange,
  onConfirmationChange,
  label = 'New password',
  autoFocus,
}: {
  password: string;
  confirmation: string;
  onPasswordChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const mismatch = confirmation.length > 0 && password !== confirmation;

  return (
    <div className="space-y-3">
      <Field label={label} required>
        <input
          className={inputClass}
          type="password"
          autoComplete="new-password"
          autoFocus={autoFocus}
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
        />
        <PasswordRequirements value={password} />
      </Field>

      <Field
        label="Confirm password"
        required
        error={mismatch ? 'The two passwords do not match.' : undefined}
      >
        <input
          className={inputClass}
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(e) => onConfirmationChange(e.target.value)}
        />
      </Field>
    </div>
  );
}

/** Whether a pair is ready to submit. Mirrors what the API will accept. */
export function newPasswordReady(password: string, confirmation: string): boolean {
  return isPasswordAcceptable(password) && password === confirmation;
}
