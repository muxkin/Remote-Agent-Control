/** Public account IDs are decimal strings. Never parse them as a numeric type. */
export const USER_ID_PATTERN = /^[1-9][0-9]*$/;
export const USERNAME_PATTERN = /^(?=.{3,32}$)(?=.*[a-z])[a-z0-9][a-z0-9_-]*$/;

/** Exact decimal increment without a numeric conversion or fixed width. */
export function nextUserId(value: string): string {
  if (!USER_ID_PATTERN.test(value)) throw new Error('Invalid UID counter');
  const digits = value.split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] !== '9') {
      digits[i] = '123456789'['012345678'.indexOf(digits[i])];
      return digits.join('');
    }
    digits[i] = '0';
  }
  return '1' + digits.join('');
}
