use houston_core::voice::{models, reuse};

const PAYLOAD: &[u8] = b"whisper fixture weights";

fn spec() -> models::ModelSpec {
    models::ModelSpec {
        id: "ggml-tiny",
        display_name: "Tiny fixture",
        url: "http://127.0.0.1/fixture",
        sha256: "ada54ec2596d3737fcd230da1197417cd9f9d4db419d66e19e7cf104f73ed329",
        size_bytes: PAYLOAD.len() as u64,
        memory_gib: 1,
    }
}

#[test]
fn matching_external_file_is_found_by_hash_and_link_deletion_preserves_read_only_source() {
    let root = tempfile::tempdir().unwrap();
    let external = root.path().join("handy");
    let own = root.path().join("houston/models");
    std::fs::create_dir_all(&external).unwrap();
    let source = external.join("renamed-weights.bin");
    std::fs::write(&source, PAYLOAD).unwrap();
    let mut permissions = source.metadata().unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&source, permissions).unwrap();
    let (found, limited) = reuse::scan(&[(external, "Handy".into())], &[spec()]);
    assert!(!limited);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].model_id.as_deref(), Some("ggml-tiny"));
    reuse::reuse_file(&own, &source, &spec(), false).unwrap();
    assert_eq!(
        reuse::resolve_path(&own, "ggml-tiny"),
        Some(source.canonicalize().unwrap())
    );
    assert_eq!(models::disk_usage(&own), 0);
    assert_eq!(models::delete(&own, "ggml-tiny").unwrap(), 0);
    assert_eq!(std::fs::read(&source).unwrap(), PAYLOAD);
    assert!(source.metadata().unwrap().permissions().readonly());
    assert!(reuse::resolve_path(&own, "ggml-tiny").is_none());
}

#[test]
fn mismatch_and_a_candidate_changed_after_scan_are_never_reused() {
    let root = tempfile::tempdir().unwrap();
    let external = root.path().join("cache");
    let own = root.path().join("models");
    std::fs::create_dir_all(&external).unwrap();
    let source = external.join("ggml-tiny.bin");
    std::fs::write(&source, PAYLOAD).unwrap();
    assert_eq!(
        reuse::scan(
            &[(external.clone(), "Hugging Face cache".into())],
            &[spec()]
        )
        .0
        .len(),
        1
    );
    let mut changed = PAYLOAD.to_vec();
    changed[0] ^= 1;
    std::fs::write(&source, &changed).unwrap();
    assert!(
        reuse::scan(&[(external, "Hugging Face cache".into())], &[spec()])
            .0
            .is_empty()
    );
    for copy in [false, true] {
        let error = reuse::reuse_file(&own, &source, &spec(), copy)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("SHA-256") && error.contains("ggml-tiny"),
            "{error}"
        );
        assert!(!own.exists(), "verification must precede publication");
    }
    assert_eq!(std::fs::read(&source).unwrap(), changed);
}

#[test]
fn copy_owns_only_its_own_bytes_and_parakeet_is_named_unsupported() {
    let root = tempfile::tempdir().unwrap();
    let own = root.path().join("models");
    let source = root.path().join("external.bin");
    std::fs::write(&source, PAYLOAD).unwrap();
    reuse::reuse_file(&own, &source, &spec(), true).unwrap();
    assert_eq!(models::disk_usage(&own), PAYLOAD.len() as u64);
    assert_eq!(
        models::delete(&own, "ggml-tiny").unwrap(),
        PAYLOAD.len() as u64
    );
    assert_eq!(std::fs::read(&source).unwrap(), PAYLOAD);
    let parakeet = root.path().join("parakeet-v3.onnx");
    std::fs::write(&parakeet, b"unsupported ONNX fixture").unwrap();
    let (found, _) = reuse::scan(&[(root.path().into(), "Handy".into())], &[spec()]);
    let unsupported = found
        .iter()
        .find(|f| f.unsupported_reason.is_some())
        .unwrap();
    assert!(unsupported.model_id.is_none());
    assert!(unsupported
        .unsupported_reason
        .as_deref()
        .unwrap()
        .contains("Parakeet"));
}

#[test]
fn scan_bounds_report_partial_results() {
    let root = tempfile::tempdir().unwrap();
    let mut nested = root.path().to_path_buf();
    for _ in 0..8 {
        nested = nested.join("nested");
    }
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("model.bin"), PAYLOAD).unwrap();
    let (found, limited) = reuse::scan(&[(root.path().into(), "Handy".into())], &[spec()]);
    assert!(limited);
    assert!(found.is_empty());
}

#[test]
fn scan_results_are_bounded_even_for_unsupported_models() {
    let root = tempfile::tempdir().unwrap();
    for i in 0..65 {
        std::fs::write(root.path().join(format!("parakeet-{i}.onnx")), b"fixture").unwrap();
    }
    let (found, limited) = reuse::scan(&[(root.path().into(), "Handy".into())], &[spec()]);
    assert_eq!(found.len(), 64);
    assert!(limited);
}

#[test]
fn a_catalogue_hash_takes_precedence_over_an_unsupported_filename() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("parakeet-renamed.bin"), PAYLOAD).unwrap();
    let (found, limited) = reuse::scan(&[(root.path().into(), "Handy".into())], &[spec()]);
    assert!(!limited);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].model_id.as_deref(), Some("ggml-tiny"));
    assert!(found[0].unsupported_reason.is_none());
}

#[test]
fn channel_scan_excludes_current_state_and_invalid_channel_names() {
    let home = tempfile::tempdir().unwrap();
    let current = home.path().join(".houston-dev/models");
    let release = home.path().join(".houston/models");
    let named = home.path().join(".houston-test/models");
    let invalid = home.path().join(".houston-INVALID/models");
    for dir in [&current, &release, &named, &invalid] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let roots = reuse::scan_roots(home.path(), &current);
    assert!(roots.iter().any(|(p, _)| p == &release));
    assert!(roots.iter().any(|(p, _)| p == &named));
    assert!(!roots.iter().any(|(p, _)| p == &current || p == &invalid));
    assert!(roots
        .iter()
        .any(|(p, _)| p == &home.path().join(".cache/huggingface/hub")));
    assert!(roots
        .iter()
        .any(|(p, _)| p == &home.path().join(".local/share/com.pais.handy/models")));
}

#[test]
fn concurrent_scan_admission_is_bounded_and_recovers_when_the_worker_ends() {
    let runtime = houston_core::voice::runtime::Runtime::new();
    let first = runtime.claim_scan().unwrap();
    assert!(runtime.claim_scan().is_none());
    drop(first);
    assert!(runtime.claim_scan().is_some());
}

#[cfg(unix)]
#[test]
fn engine_rejects_changed_external_weights_before_the_whisper_loader() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("external.bin");
    let mut changed = PAYLOAD.to_vec();
    changed[0] ^= 1;
    std::fs::write(&source, changed).unwrap();
    let runtime = houston_core::voice::runtime::Runtime::new();
    let error = runtime.local_engine(&source, Some(&spec())).unwrap_err();
    assert!(matches!(
        error,
        houston_core::voice::whisper::WhisperEngineError::Verification(_)
    ));
    assert!(error.to_string().contains("SHA-256"));
}
