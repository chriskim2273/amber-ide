use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Upstream answered. Commit the response.
    Success,
    /// Transient. Cool the key down and try the next endpoint.
    CoolDown { retry_after: Option<Duration> },
    /// Credential is bad. Kill the key for the process, try the next endpoint.
    DeadKey,
    /// Return to the client immediately. Do NOT walk the chain: a context-length
    /// overflow or an unsupported parameter fails identically on every provider,
    /// and walking the chain would surface the last provider's error instead.
    Fatal,
}

pub fn parse_retry_after(raw: &str) -> Option<Duration> {
    raw.trim().parse::<u64>().ok().map(Duration::from_secs)
}

pub fn classify_status(status: u16, retry_after_header: Option<&str>) -> Verdict {
    match status {
        200..=299 => Verdict::Success,
        // Spec non-cascades 400; 422 is the same class of client-side request error.
        400 | 422 => Verdict::Fatal,
        401 | 403 => Verdict::DeadKey,
        429 => Verdict::CoolDown {
            retry_after: retry_after_header.and_then(parse_retry_after),
        },
        // Provider-specific 4xx (402/404/408/…) must not abort the chain.
        _ => Verdict::CoolDown { retry_after: None },
    }
}

/// Connect failure, read timeout, or first-byte timeout.
pub fn classify_transport() -> Verdict {
    Verdict::CoolDown { retry_after: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn success_range() {
        assert!(matches!(classify_status(200, None), Verdict::Success));
        assert!(matches!(classify_status(201, None), Verdict::Success));
    }

    #[test]
    fn bad_request_is_fatal_and_must_not_cascade() {
        assert!(matches!(classify_status(400, None), Verdict::Fatal));
    }

    #[test]
    fn auth_failures_kill_the_key() {
        assert!(matches!(classify_status(401, None), Verdict::DeadKey));
        assert!(matches!(classify_status(403, None), Verdict::DeadKey));
    }

    #[test]
    fn rate_limit_parses_retry_after_seconds() {
        match classify_status(429, Some("7")) {
            Verdict::CoolDown { retry_after } => {
                assert_eq!(retry_after, Some(Duration::from_secs(7)))
            }
            other => panic!("expected CoolDown, got {other:?}"),
        }
    }

    #[test]
    fn rate_limit_without_header_leaves_backoff_to_health() {
        match classify_status(429, None) {
            Verdict::CoolDown { retry_after } => assert_eq!(retry_after, None),
            other => panic!("expected CoolDown, got {other:?}"),
        }
    }

    #[test]
    fn unparseable_retry_after_is_ignored() {
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
        assert_eq!(parse_retry_after(""), None);
        assert_eq!(parse_retry_after("12"), Some(Duration::from_secs(12)));
    }

    #[test]
    fn server_errors_cool_down() {
        assert!(matches!(
            classify_status(500, None),
            Verdict::CoolDown { retry_after: None }
        ));
        assert!(matches!(
            classify_status(503, None),
            Verdict::CoolDown { retry_after: None }
        ));
    }

    #[test]
    fn unprocessable_entity_is_fatal() {
        assert!(matches!(classify_status(422, None), Verdict::Fatal));
    }

    #[test]
    fn other_client_errors_cool_down_without_retry_after() {
        for status in [402, 404, 408, 409, 418, 451] {
            match classify_status(status, Some("7")) {
                Verdict::CoolDown { retry_after } => {
                    assert_eq!(retry_after, None, "{status} must ignore Retry-After");
                }
                other => panic!("expected CoolDown for {status}, got {other:?}"),
            }
        }
    }

    #[test]
    fn transport_failures_cool_down() {
        assert!(matches!(
            classify_transport(),
            Verdict::CoolDown { retry_after: None }
        ));
    }
}
