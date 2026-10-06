export function actionToken(fragment: string): string | undefined {
  if (!fragment.startsWith("#")) return undefined;
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const tokens = params.getAll("token");
  if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 2048 || /[\s\x00-\x1f\x7f]/.test(tokens[0])) return undefined;
  return tokens[0];
}

export function passwordConfirmationError(password: string, confirmation: string): string | undefined {
  if (password.length < 12 || password.length > 128) return "Use a password between 12 and 128 characters.";
  if (password !== confirmation) return "The new passwords do not match.";
  return undefined;
}
