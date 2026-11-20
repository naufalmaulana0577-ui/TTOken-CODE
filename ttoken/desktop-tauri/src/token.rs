//! Random credentials: the Host startup secret and WebSocket tickets.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Create 32 random bytes encoded as unpadded base64url.
///
/// The 43-character result is the only form the Host accepts in its `desktop-auth` message.
///
/// # Panics
///
/// Panics when the operating system random source fails, because no credential can be issued without it.
pub fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("operating system random source is unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::random_token;

    #[test]
    fn tokens_have_the_host_credential_form() {
        let token = random_token();
        assert_eq!(token.len(), 43);
        assert!(
            token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        );
        assert_ne!(token, random_token());
    }
}
