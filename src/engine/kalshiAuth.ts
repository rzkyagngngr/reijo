import crypto from 'node:crypto';

export interface KalshiAuthHeaders extends Record<string, string> {
  'KALSHI-ACCESS-KEY': string;
  'KALSHI-ACCESS-TIMESTAMP': string;
  'KALSHI-ACCESS-SIGNATURE': string;
  'Content-Type': string;
}

/**
 * Generates RSA-PSS SHA-256 authentication headers required by Kalshi Trade API v2.
 * Pre-sign message string: timestampMs + UPPERCASE_METHOD + pathWithoutQuery
 */
export function buildKalshiAuthHeaders(
  apiKeyId: string,
  privateKeyPem: string,
  method: string,
  pathWithOptionalQuery: string,
  timestampMs: number = Date.now()
): KalshiAuthHeaders {
  const cleanPath = pathWithOptionalQuery.split('?')[0];
  const timestamp = String(timestampMs);
  const message = `${timestamp}${method.toUpperCase()}${cleanPath}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  signer.end();

  const signature = signer.sign(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64'
  );

  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Content-Type': 'application/json',
  };
}
