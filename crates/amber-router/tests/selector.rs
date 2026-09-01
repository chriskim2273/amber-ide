use std::sync::Arc;
use std::time::{Duration, Instant};

use router_core::config::Config;
use router_core::registry::Registry;
use amber_router::selector::{AcquireError, Selector};

const SRC: &str = r#"
[server]

[[provider]]
name = "a"
base_url = "http://a.example"
keys = ["k1", "k2"]
max_inflight_per_key = 1
default_cooldown_ms = 100
max_cooldown_ms = 1000

[[provider]]
name = "b"
base_url = "http://b.example"
keys = ["k3"]
max_inflight_per_key = 1

[[alias]]
name = "smart"
chain = [
  { provider = "a", model = "m1" },
  { provider = "b", model = "m2" },
]
"#;

fn selector() -> (Arc<Registry>, Selector) {
    let reg = Arc::new(Registry::build(Config::load_str(SRC, &|_| None).unwrap()));
    let sel = Selector::new(reg.clone());
    (reg, sel)
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

#[tokio::test]
async fn picks_endpoints_in_chain_order() {
    let (reg, sel) = selector();
    let chain = reg.chain("smart").unwrap().to_vec();
    let l1 = sel.acquire(&chain, deadline()).await.unwrap();
    assert_eq!(reg.key_label(&l1.endpoint), "a#0");
    let l2 = sel.acquire(&chain, deadline()).await.unwrap();
    assert_eq!(
        reg.key_label(&l2.endpoint),
        "a#1",
        "first key saturated, move on"
    );
    let l3 = sel.acquire(&chain, deadline()).await.unwrap();
    assert_eq!(reg.key_label(&l3.endpoint), "b#0");
}

#[tokio::test]
async fn permit_is_released_on_drop() {
    let (reg, sel) = selector();
    let chain = reg.chain("smart").unwrap().to_vec();
    {
        let l = sel.acquire(&chain, deadline()).await.unwrap();
        assert_eq!(reg.key_label(&l.endpoint), "a#0");
    }
    let again = sel.acquire(&chain, deadline()).await.unwrap();
    assert_eq!(reg.key_label(&again.endpoint), "a#0", "permit returned");
}

#[tokio::test]
async fn cooldown_does_not_strand_queued_work() {
    let (reg, sel) = selector();
    let chain = reg.chain("smart").unwrap().to_vec();
    let sel = std::sync::Arc::new(sel);

    // Saturate every endpoint: a#0, a#1, b#0 (max_inflight_per_key = 1 each).
    let mut held = Vec::new();
    for _ in 0..chain.len() {
        held.push(sel.acquire(&chain, deadline()).await.unwrap());
    }

    // A request arrives with nothing free and must wait.
    let waiter = {
        let sel = sel.clone();
        let chain = chain.clone();
        tokio::spawn(async move {
            sel.acquire(&chain, Instant::now() + Duration::from_secs(5))
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;

    // While it waits, both `a` keys go into a long cooldown, and b#0 frees up.
    // A key-bound queue would leave the waiter parked behind a cooling key forever.
    sel.report_cooldown(&chain[0], Some(Duration::from_secs(600)), "429".into());
    sel.report_cooldown(&chain[1], Some(Duration::from_secs(600)), "429".into());
    let b_lease = held.pop().unwrap();
    drop(b_lease);

    let lease = tokio::time::timeout(Duration::from_secs(2), waiter)
        .await
        .expect("waiter must not be stranded behind the cooling keys")
        .unwrap()
        .unwrap();
    assert_eq!(reg.key_label(&lease.endpoint), "b#0");
    drop(held);
}

#[tokio::test]
async fn waits_for_a_cooling_key_to_recover() {
    let (reg, sel) = selector();
    let chain = reg.chain("smart").unwrap().to_vec();
    for e in &chain {
        sel.report_cooldown(e, Some(Duration::from_millis(150)), "429".into());
    }
    let start = Instant::now();
    let l = sel.acquire(&chain, deadline()).await.unwrap();
    assert!(start.elapsed() >= Duration::from_millis(140));
    assert_eq!(reg.key_label(&l.endpoint), "a#0");
}

#[tokio::test]
async fn all_dead_fails_immediately() {
    let (reg, sel) = selector();
    let chain = reg.chain("smart").unwrap().to_vec();
    for e in &chain {
        sel.report_dead(e, "401".into());
    }
    let start = Instant::now();
    let err = sel.acquire(&chain, deadline()).await.unwrap_err();
    assert!(matches!(err, AcquireError::AllDead));
    assert!(
        start.elapsed() < Duration::from_millis(100),
        "must not wait"
    );
}

#[tokio::test]
async fn deadline_expiry_returns_timeout() {
    let (reg, sel) = selector();
    let chain = reg.chain("smart").unwrap().to_vec();
    for e in &chain {
        sel.report_cooldown(e, Some(Duration::from_secs(600)), "429".into());
    }
    let err = sel
        .acquire(&chain, Instant::now() + Duration::from_millis(120))
        .await
        .unwrap_err();
    assert!(matches!(err, AcquireError::Timeout));
}

#[tokio::test]
async fn snapshot_reports_state_without_leaking_keys() {
    let (reg, sel) = selector();
    let chain = reg.chain("smart").unwrap().to_vec();
    let held = sel.acquire(&chain, deadline()).await.unwrap();
    sel.report_dead(&chain[2], "401".into());

    let snap = sel.snapshot();
    assert_eq!(snap.len(), 3);
    assert_eq!(snap[0].label, "a#0");
    assert_eq!(snap[0].in_flight, 1);
    assert_eq!(snap[2].state, "dead");
    for s in &snap {
        assert!(!s.label.contains("k1") && !s.label.contains("k3"));
    }
    drop(held);

    let snap_after = sel.snapshot();
    assert_eq!(
        snap_after[0].in_flight, 0,
        "in_flight must return to 0 after the lease drops"
    );
}

#[tokio::test]
async fn releasing_a_permit_wakes_a_waiter_promptly() {
    let (reg, sel) = selector();
    let chain = reg.chain("smart").unwrap().to_vec();

    // Saturate every endpoint in the chain (each key has max_inflight_per_key = 1).
    let mut held = Vec::new();
    for _ in 0..chain.len() {
        held.push(sel.acquire(&chain, deadline()).await.unwrap());
    }

    let sel = std::sync::Arc::new(sel);
    let waiter = {
        let sel = sel.clone();
        let chain = chain.clone();
        tokio::spawn(async move {
            let start = Instant::now();
            let lease = sel
                .acquire(&chain, Instant::now() + Duration::from_secs(5))
                .await
                .unwrap();
            (lease, start.elapsed())
        })
    };

    // Let the waiter reach its wait point, then release one permit.
    tokio::time::sleep(Duration::from_millis(20)).await;
    drop(held.pop().unwrap());

    let (_lease, waited) = waiter.await.unwrap();
    assert!(
        waited < Duration::from_millis(45),
        "waiter should wake on the release notification, not the 50ms poll (waited {waited:?})"
    );
}
