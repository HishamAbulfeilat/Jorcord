-- OAuth2 PKCE (RFC 7636, S256 only): the challenge is bound to the authorization code and must be proven at the token endpoint.
ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS code_challenge TEXT;
