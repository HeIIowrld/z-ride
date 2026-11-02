/** Integration port only. Google Cloud configuration and real verifier are not shipped. */
export function createAuthProviders({ googleClientId = '', publicOrigin = '', verifyGoogleIdToken } = {}) {
  const configured = !!googleClientId && publicOrigin.startsWith('https://');
  return {
    describe() { return {
      guest: { enabled:true, method:'CAR_INVITE' },
      google: { enabled:false, configured, reason: configured ? 'ACCOUNT_LINKING_ADAPTER_REQUIRED' : 'HTTPS_AND_CLIENT_ID_REQUIRED' },
      pleos: { enabled:false, purpose:'VEHICLE_DATA_OWNER_AUTHORIZATION', generalGameLogin:false, reason:'REGION_SUPPORT_AND_API_APPROVAL_REQUIRED' },
    }; },
    async verifyGoogle({ credential, expectedNonce }) {
      if (!configured || !verifyGoogleIdToken) throw Object.assign(new Error('Google account linking is not configured'),{code:'AUTH_PROVIDER_DISABLED',status:503});
      const claims=await verifyGoogleIdToken({credential,audience:googleClientId,expectedNonce});
      if (!claims?.sub || !expectedNonce || claims.nonce!==expectedNonce) throw Object.assign(new Error('Invalid provider claims'),{code:'AUTH_PROVIDER_REJECTED',status:401});
      return { provider:'google', subject:claims.sub };
    },
  };
}
