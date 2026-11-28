use std::thread;
use std::time::Duration;

use aquapilot_service::store::Store;
use aquapilot_service::worker::spawn_worker;

#[test]
fn worker_executes_a_queued_experiment() {
    let store = Store::in_memory(4).expect("store");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/a2o-asm2d.json")).expect("fixture");
    let request = serde_json::json!({
        "name": "worker-smoke",
        "model": "asm2d",
        "config": config,
        "duration_min": 30.0,
        "dt_min": 1.0,
        "sample_every_min": 10.0
    });
    store
        .create(
            "worker-1",
            "worker-smoke",
            "asm2d",
            &serde_json::to_string(&request).expect("request"),
            None,
            "body-hash",
        )
        .expect("create");
    let _worker = spawn_worker(store.clone());
    for _ in 0..100 {
        let record = store.get("worker-1").expect("get").expect("record");
        if record.status == "succeeded" {
            let result: serde_json::Value =
                serde_json::from_str(record.result_json.as_deref().expect("result"))
                    .expect("result json");
            assert!(result["effluent"]["cod"].as_f64().expect("cod").is_finite());
            let samples: Vec<serde_json::Value> =
                serde_json::from_str(record.samples_json.as_deref().expect("samples"))
                    .expect("samples json");
            assert!(!samples.is_empty());
            return;
        }
        assert_ne!(record.status, "failed", "worker failed: {:?}", record.error);
        thread::sleep(Duration::from_millis(50));
    }
    panic!("worker did not finish within 5 seconds");
}
