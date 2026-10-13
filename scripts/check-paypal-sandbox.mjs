export async function requestSandboxToken({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId?.trim() || !clientSecret?.trim()) {
    throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET locally.');
  }
  let response;
  try {
    response = await fetchImpl(
      'https://api-m.sandbox.paypal.com/v1/oauth2/token',
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error(
      'PayPal sandbox request failed or timed out; no credentials were logged.',
    );
  }
  if (!response.ok) {
    throw new Error(
      `PayPal sandbox token request failed (HTTP ${response.status}).`,
    );
  }
  let token;
  try {
    token = await response.json();
  } catch {
    throw new Error('PayPal sandbox returned an invalid token response.');
  }
  if (
    typeof token?.access_token !== 'string' ||
    !token.access_token.trim() ||
    token.token_type !== 'Bearer' ||
    !Number.isSafeInteger(token.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new Error('PayPal sandbox returned an invalid token response.');
  }
  return token;
}

export async function checkSandboxToken(options) {
  const token = await requestSandboxToken(options);
  return {
    environment: 'sandbox',
    token_type: 'Bearer',
    expires_in: token.expires_in,
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await checkSandboxToken()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
