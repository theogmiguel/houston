const CALLBACK_PATTERN = /^[a-z][a-z\d+.-]*:\/\//iu;
const MAX_CALLBACK_LENGTH = 16_384;

/**
 * The address an OAuth sign-in sent the browser back to, as the user pasted it, if it answers
 * this sign-in: the redirect's own address, its one state, and one code or one error. Throws
 * otherwise. The message names the expected shape and never repeats the pasted value, which
 * carries an authorization code.
 */
export function oauthCallbackUrl(value: string, redirectUri: string, state: string) {
  const expected = new URL(redirectUri);
  const refusal = () =>
    new Error(
      `This redirect URL does not belong to the current sign-in. Expected ${expected.origin}${expected.pathname} with the state of this sign-in and either one code or one error.`,
    );
  if (value.length > MAX_CALLBACK_LENGTH) throw refusal();
  let callback: URL;
  try {
    callback = pastedUrl(value, expected.protocol);
  } catch {
    // The URL parser's error repeats its input, which here is a credential.
    throw refusal();
  }
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    states.length !== 1 ||
    states[0] !== state ||
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  )
    throw refusal();
  return callback;
}

/** A URL copied from an address bar, which can hide its `http://`. Throws if it isn't one. */
export function pastedUrl(value: string, protocol = "http:") {
  const pasted = value.trim();
  return new URL(CALLBACK_PATTERN.test(pasted) ? pasted : `${protocol}//${pasted}`);
}
