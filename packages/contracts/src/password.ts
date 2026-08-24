import { z } from 'zod';

/**
 * Password rules from SRS v2.3 §3.2, expressed once.
 *
 * The API enforces these and the portal displays them from the same source, so
 * the checklist a user sees while typing cannot drift from the rule that
 * rejects them on submit.
 *
 * The SRS states "minimum 8 to 12 characters". Eight is taken as the floor —
 * refusing a nine-character password that the specification's own e-mail
 * templates describe as acceptable would be a defect — and twelve is presented
 * as the recommendation.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RECOMMENDED_LENGTH = 12;

/** Kept short of Argon2's practical limits, and long enough for any passphrase. */
export const PASSWORD_MAX_LENGTH = 200;

export interface PasswordRule {
  id: 'length' | 'uppercase' | 'lowercase' | 'number' | 'symbol';
  label: string;
  test: (value: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: 'length',
    label: `At least ${PASSWORD_MIN_LENGTH} characters (${PASSWORD_RECOMMENDED_LENGTH} or more recommended)`,
    test: (v) => v.length >= PASSWORD_MIN_LENGTH,
  },
  { id: 'uppercase', label: 'An uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { id: 'lowercase', label: 'A lowercase letter', test: (v) => /[a-z]/.test(v) },
  { id: 'number', label: 'A number', test: (v) => /[0-9]/.test(v) },
  {
    id: 'symbol',
    label: 'A symbol, such as @ # $ or !',
    // Anything that is not a letter, a digit or whitespace. Deliberately not a
    // fixed list: a user whose password manager generated a tilde should not be
    // told it is not a symbol.
    test: (v) => /[^A-Za-z0-9\s]/.test(v),
  },
];

/** Which rules a candidate fails. Empty means it is acceptable. */
export function passwordProblems(value: string): PasswordRule[] {
  if (value.length > PASSWORD_MAX_LENGTH) return PASSWORD_RULES;
  return PASSWORD_RULES.filter((rule) => !rule.test(value));
}

export function isPasswordAcceptable(value: string): boolean {
  return passwordProblems(value).length === 0;
}

/**
 * A password field that enforces the policy.
 *
 * Every unmet rule is reported at once rather than one per attempt, because a
 * form that reveals its requirements one rejection at a time is how people end
 * up with `Password1!`.
 */
export const StrongPassword = z
  .string()
  .max(PASSWORD_MAX_LENGTH, `Use no more than ${PASSWORD_MAX_LENGTH} characters.`)
  .superRefine((value, ctx) => {
    const problems = passwordProblems(value);
    if (problems.length === 0) return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Your password needs: ${problems.map((p) => p.label.toLowerCase()).join('; ')}.`,
    });
  });
