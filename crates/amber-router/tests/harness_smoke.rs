mod support;
use support::mock_provider::{MockProvider, Reply};

#[tokio::test]
async fn mock_returns_scripted_status_then_repeats_last() {
    let mock = MockProvider::start(vec![
        Reply::Status {
            code: 429,
            body: "slow down".into(),
            retry_after: Some("7".into()),
        },
        Reply::Status {
            code: 500,
            body: "boom".into(),
            retry_after: None,
        },
    ]);
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", mock.base_url());

    let r1 = client.post(&url).send().await.unwrap();
    assert_eq!(r1.status().as_u16(), 429);
    assert_eq!(r1.headers().get("retry-after").unwrap(), "7");

    let r2 = client.post(&url).send().await.unwrap();
    assert_eq!(r2.status().as_u16(), 500);

    let r3 = client.post(&url).send().await.unwrap();
    assert_eq!(r3.status().as_u16(), 500, "last reply repeats");
    assert_eq!(mock.hits(), 3);
}
