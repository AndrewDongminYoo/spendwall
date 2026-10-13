export function requestSandboxToken(options?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<{
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}>;
