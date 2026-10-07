use houston_core::db::{Db, TaskRunWrite, TaskUpdate, TaskWrite};
use houston_core::task_trackers::RemoteTaskSnapshot;
use houston_protocol as proto;
use std::collections::BTreeMap;

fn snapshot(title: &str, description: &str, status: &str) -> RemoteTaskSnapshot {
    RemoteTaskSnapshot {
        external_id: "owner/repo#41".into(),
        url: "https://github.com/owner/repo/issues/41".into(),
        remote_rev: Some("rev-1".into()),
        fields: BTreeMap::from([
            ("title".into(), title.into()),
            ("description".into(), description.into()),
            ("status".into(), status.into()),
        ]),
        project: Some(proto::TaskTrackerProjectSnapshot {
            external_id: "github_issues:owner/repo:milestone:7".into(),
            url: "https://github.com/owner/repo/milestone/7".into(),
            title: "Milestone 7".into(),
            description: "Imported project description".into(),
            unverified: true,
        }),
    }
}

fn github_settings(workspace: &str) -> proto::TaskTrackerWorkspaceSettings {
    proto::TaskTrackerWorkspaceSettings {
        workspace: workspace.into(),
        provider: proto::TaskTrackerProvider::GithubIssues,
        enabled: true,
        github_repository: Some("owner/repo".into()),
        github_label: Some("houston".into()),
        github_assigned_user: None,
        notion_data_source_id: None,
        notion_title_property_id: None,
        notion_description_property_id: None,
        notion_status_property_id: None,
        notion_assignee_property_id: None,
        notion_project_relation_property_id: None,
        notion_assignee_user_id: None,
        notion_active_status_values: vec![],
        notion_projects_data_source_id: None,
        notion_project_title_property_id: None,
        notion_project_description_property_id: None,
        notion_pr_url_property_id: None,
        notion_status_mapping: proto::TaskTrackerStatusMapping {
            todo: None,
            in_progress: None,
            in_review: None,
            done: None,
            canceled: None,
        },
        has_credential: false,
        last_sync_at_ms: None,
        last_error: None,
    }
}

fn create_task(
    db: &Db,
    workspace: Option<&str>,
    title: &str,
    status: proto::TaskStatus,
    parent_id: Option<i64>,
) -> i64 {
    db.create_task(&TaskWrite {
        workspace,
        title,
        description: "Task body",
        status,
        priority: proto::TaskPriority::None,
        parent_id,
        ref_url: None,
        created_by: "test",
        now_ms: 1,
        acceptance: &[],
    })
    .unwrap()
    .id
}

#[test]
fn remote_import_is_idempotent_and_live_local_edits_become_explicit_conflicts() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-import.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";

    let id = db
        .task_tracker_import_remote(
            workspace,
            proto::TaskTrackerProvider::GithubIssues,
            &snapshot("Remote title", "Base description", "todo"),
            10,
        )
        .unwrap();
    let imported = db.task(id).unwrap().unwrap();
    assert_eq!(imported.workspace.as_deref(), Some(workspace));
    assert_eq!(imported.title, "Remote title");
    assert!(
        db.task_runs(id, 10).unwrap().is_empty(),
        "tracker import must not start an agent run"
    );
    let link = db.task_external_links(id).unwrap().remove(0);
    assert_eq!(
        link.snapshot.project_external_id.as_deref(),
        Some("github_issues:owner/repo:milestone:7")
    );
    assert!(link.snapshot.project.as_ref().unwrap().unverified);

    let local_edit = TaskUpdate {
        workspace: Some(workspace),
        id,
        expected_revision: imported.revision,
        title: "Local title",
        description: "Base description",
        status: proto::TaskStatus::Todo,
        priority: imported.priority,
        parent_id: imported.parent_id,
        ref_url: imported.ref_url.as_deref(),
        acceptance: None,
        actor: "user",
        action: "task_update",
        changes: "{}",
        now_ms: 11,
    };
    assert!(db.update_task(&local_edit).unwrap());
    let remote = snapshot(
        "Concurrent remote title",
        "Remote-only description",
        "in_progress",
    );
    let updated_id = db
        .task_tracker_import_remote(
            workspace,
            proto::TaskTrackerProvider::GithubIssues,
            &remote,
            12,
        )
        .unwrap();
    assert_eq!(updated_id, id);

    let task = db.task(id).unwrap().unwrap();
    assert_eq!(task.title, "Local title");
    assert_eq!(task.description, "Base description");
    assert_eq!(task.status, proto::TaskStatus::Todo);
    let link = db.task_external_links(id).unwrap().remove(0);
    let conflict = link
        .snapshot
        .conflicts
        .iter()
        .find(|conflict| conflict.field == "title")
        .unwrap();
    assert_eq!(conflict.base, "Remote title");
    assert_eq!(conflict.local, "Local title");
    assert_eq!(conflict.remote, "Concurrent remote title");
    assert_eq!(
        link.snapshot.local.get("title").map(String::as_str),
        Some("Local title")
    );
    assert_eq!(
        link.snapshot.base.get("description").map(String::as_str),
        Some("Base description")
    );
    assert_eq!(link.snapshot.conflicts.len(), 3);
    assert_eq!(link.sync_state, proto::TaskTrackerSyncState::Diverged);
    assert!(db.task_has_unresolved_tracker_conflicts(id).unwrap());
    assert_eq!(db.task_history(id, 10).unwrap().len(), 2);

    let same = db
        .task_tracker_import_remote(
            workspace,
            proto::TaskTrackerProvider::GithubIssues,
            &remote,
            13,
        )
        .unwrap();
    assert_eq!(same, id);
    assert_eq!(db.task(id).unwrap().unwrap().revision, task.revision);
    assert_eq!(
        db.task_external_links(id).unwrap()[0]
            .snapshot
            .conflicts
            .len(),
        1
    );
}

#[test]
fn remote_only_changes_are_diverged_without_silent_task_mutation_and_resolve_explicitly() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-reconcile.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    let id = db
        .task_tracker_import_remote(
            workspace,
            proto::TaskTrackerProvider::GithubIssues,
            &snapshot("Title", "Description", "todo"),
            20,
        )
        .unwrap();
    let original = db.task(id).unwrap().unwrap();
    let mut remote = snapshot("Title", "Description", "todo");
    remote.fields.insert("status".into(), "in_progress".into());
    db.task_tracker_import_remote(
        workspace,
        proto::TaskTrackerProvider::GithubIssues,
        &remote,
        21,
    )
    .unwrap();
    let unchanged = db.task(id).unwrap().unwrap();
    assert_eq!(unchanged.revision, original.revision);
    assert_eq!(unchanged.status, proto::TaskStatus::Todo);
    assert_eq!(db.task_history(id, 10).unwrap().len(), 1);
    let link = db.task_external_links(id).unwrap().remove(0);
    let conflict = link
        .snapshot
        .conflicts
        .iter()
        .find(|conflict| conflict.field == "status")
        .unwrap();
    assert_eq!(conflict.base, "todo");
    assert_eq!(conflict.local, "todo");
    assert_eq!(conflict.remote, "in_progress");
    assert_eq!(link.sync_state, proto::TaskTrackerSyncState::Diverged);

    db.task_tracker_conflict_resolve(
        id,
        original.revision,
        None,
        proto::TaskTrackerProvider::GithubIssues,
        "owner/repo#41",
        "status",
        link.snapshot.revision,
        &proto::TaskTrackerConflictResolution::Remote,
    )
    .unwrap()
    .unwrap();
    let resolved = db.task(id).unwrap().unwrap();
    assert_eq!(resolved.revision, original.revision + 1);
    assert_eq!(resolved.status, proto::TaskStatus::InProgress);
    assert_eq!(db.task_history(id, 10).unwrap().len(), 2);
    assert!(!db.task_has_unresolved_tracker_conflicts(id).unwrap());
}

#[test]
fn unchanged_remote_status_preserves_a_human_local_status_edit_without_conflict() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-unchanged-status.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    let id = db
        .task_tracker_import_remote(
            workspace,
            proto::TaskTrackerProvider::GithubIssues,
            &snapshot("Title", "Description", "todo"),
            30,
        )
        .unwrap();
    let imported = db.task(id).unwrap().unwrap();
    let local_edit = TaskUpdate {
        workspace: Some(workspace),
        id,
        expected_revision: imported.revision,
        title: &imported.title,
        description: &imported.description,
        status: proto::TaskStatus::InProgress,
        priority: imported.priority,
        parent_id: imported.parent_id,
        ref_url: imported.ref_url.as_deref(),
        acceptance: None,
        actor: "user",
        action: "task_update",
        changes: "{\"status\":true}",
        now_ms: 31,
    };
    assert!(db.update_task(&local_edit).unwrap());

    db.task_tracker_import_remote(
        workspace,
        proto::TaskTrackerProvider::GithubIssues,
        &snapshot("Title", "Description", "todo"),
        32,
    )
    .unwrap();

    let task = db.task(id).unwrap().unwrap();
    assert_eq!(task.status, proto::TaskStatus::InProgress);
    assert_eq!(task.revision, imported.revision + 1);
    assert_eq!(db.task_history(id, 10).unwrap().len(), 2);
    let link = db.task_external_links(id).unwrap().remove(0);
    assert!(link.snapshot.conflicts.is_empty());
    assert_eq!(link.sync_state, proto::TaskTrackerSyncState::Pending);
    assert_eq!(
        link.snapshot.local.get("status").map(String::as_str),
        Some("in_progress")
    );
}

#[test]
fn a_conflicting_task_field_stays_unresolved_when_a_later_poll_converges() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-converged-conflict.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    let id = db
        .task_tracker_import_remote(
            workspace,
            proto::TaskTrackerProvider::GithubIssues,
            &snapshot("Base", "Description", "todo"),
            40,
        )
        .unwrap();
    let original = db.task(id).unwrap().unwrap();
    let edit = TaskUpdate {
        workspace: Some(workspace),
        id,
        expected_revision: original.revision,
        title: "Chosen locally",
        description: &original.description,
        status: original.status,
        priority: original.priority,
        parent_id: original.parent_id,
        ref_url: original.ref_url.as_deref(),
        acceptance: None,
        actor: "user",
        action: "task_update",
        changes: "{\"title\":true}",
        now_ms: 41,
    };
    assert!(db.update_task(&edit).unwrap());
    let mut divergent = snapshot("Changed remotely", "Description", "todo");
    db.task_tracker_import_remote(
        workspace,
        proto::TaskTrackerProvider::GithubIssues,
        &divergent,
        42,
    )
    .unwrap();
    divergent
        .fields
        .insert("title".into(), "Chosen locally".into());
    db.task_tracker_import_remote(
        workspace,
        proto::TaskTrackerProvider::GithubIssues,
        &divergent,
        43,
    )
    .unwrap();

    let task = db.task(id).unwrap().unwrap();
    let link = db.task_external_links(id).unwrap().remove(0);
    assert_eq!(task.title, "Chosen locally");
    assert_eq!(task.revision, original.revision + 1);
    assert_eq!(db.task_history(id, 10).unwrap().len(), 2);
    assert_eq!(link.sync_state, proto::TaskTrackerSyncState::Diverged);
    let conflict = link
        .snapshot
        .conflicts
        .iter()
        .find(|conflict| conflict.field == "title")
        .unwrap();
    assert_eq!(conflict.base, "Base");
    assert_eq!(conflict.local, "Chosen locally");
    assert_eq!(conflict.remote, "Chosen locally");
}

#[test]
fn successful_create_receipt_preserves_existing_conflicts() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-receipt-conflict.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    let id = db
        .task_tracker_import_remote(
            workspace,
            proto::TaskTrackerProvider::GithubIssues,
            &snapshot("Task", "Description", "todo"),
            50,
        )
        .unwrap();
    let mut link = db.task_external_links(id).unwrap().remove(0);
    link.snapshot
        .conflicts
        .push(proto::TaskTrackerFieldConflict {
            field: "description".into(),
            base: "Description".into(),
            local: "Local description".into(),
            remote: "Remote description".into(),
        });
    link.sync_state = proto::TaskTrackerSyncState::Diverged;
    db.task_external_link_upsert(&link).unwrap();

    assert!(db
        .task_tracker_write_receipt(
            id,
            proto::TaskTrackerProvider::GithubIssues,
            "create",
            Some("owner/repo#41"),
            Some("https://github.com/owner/repo/issues/41"),
            Some("etag-2"),
            51,
        )
        .unwrap());
    let updated = db.task_external_links(id).unwrap().remove(0);
    assert_eq!(updated.snapshot.conflicts, link.snapshot.conflicts);
    assert_eq!(updated.snapshot.revision, link.snapshot.revision);
    assert_eq!(updated.sync_state, proto::TaskTrackerSyncState::Diverged);
    assert_eq!(updated.remote_rev.as_deref(), Some("etag-2"));
    db.task_tracker_write_receipt(
        id,
        proto::TaskTrackerProvider::GithubIssues,
        "pr_reference",
        Some("owner/repo#41"),
        Some("https://github.com/owner/repo/pull/9"),
        None,
        52,
    )
    .unwrap();
    let links = db.task_external_links(id).unwrap();
    assert_eq!(links.len(), 2);
    assert!(links.iter().any(
        |link| link.source == proto::TaskExternalLinkSource::PullRequest
            && link.external_id == "https://github.com/owner/repo/pull/9"
    ));
    assert_eq!(
        links
            .iter()
            .find(|link| link.source == proto::TaskExternalLinkSource::Source)
            .unwrap()
            .snapshot
            .conflicts
            .len(),
        1
    );
}

#[test]
fn project_title_and_description_conflicts_survive_remote_convergence() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-project-converged.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    let key = "notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let project = db
        .create_tracker_project_identity(workspace, key, "Local project", 60)
        .unwrap()
        .unwrap();
    let project = db
        .save_task_project(
            workspace,
            Some(project.id),
            Some(project.revision),
            "Local project",
            Some("https://www.notion.so/project"),
            Some("Local description"),
            &[],
            61,
        )
        .unwrap()
        .unwrap();
    let mut remote = snapshot("Task", "Description", "todo");
    remote.external_id = "cccccccccccccccccccccccccccccccc".into();
    remote.project = Some(proto::TaskTrackerProjectSnapshot {
        external_id: key.into(),
        url: "https://www.notion.so/project".into(),
        title: "Remote title".into(),
        description: "Remote description".into(),
        unverified: true,
    });
    let id = db
        .task_tracker_import_remote(workspace, proto::TaskTrackerProvider::Notion, &remote, 62)
        .unwrap();
    remote.project.as_mut().unwrap().title = "Local project".into();
    remote.project.as_mut().unwrap().description = "Local description".into();
    db.task_tracker_import_remote(workspace, proto::TaskTrackerProvider::Notion, &remote, 63)
        .unwrap();

    let link = db.task_external_links(id).unwrap().remove(0);
    assert_eq!(
        db.task_project(project.id).unwrap().unwrap().name,
        "Local project"
    );
    assert_eq!(
        db.task_project(project.id)
            .unwrap()
            .unwrap()
            .tracker_description
            .as_deref(),
        Some("Local description")
    );
    for (field, value) in [
        ("project.title", "Local project"),
        ("project.description", "Local description"),
    ] {
        let conflict = link
            .snapshot
            .conflicts
            .iter()
            .find(|conflict| conflict.field == field)
            .unwrap();
        assert_eq!(conflict.local, value);
        assert_eq!(conflict.remote, value);
    }
    assert_eq!(link.sync_state, proto::TaskTrackerSyncState::Diverged);
}

#[test]
fn project_snapshot_conflict_preserves_local_decisions_until_revision_checked_resolution() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-project.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    let external_id = "notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let project = db
        .create_tracker_project_identity(workspace, external_id, "Imported project", 30)
        .unwrap()
        .unwrap();
    let local_decisions = vec!["Keep the locally approved scope".to_string()];
    let project = db
        .save_task_project(
            workspace,
            Some(project.id),
            Some(project.revision),
            "Local project name",
            Some("https://www.notion.so/project"),
            Some("Local project description"),
            &local_decisions,
            31,
        )
        .unwrap()
        .unwrap();

    let mut remote = snapshot("Task", "Description", "todo");
    remote.external_id = "cccccccccccccccccccccccccccccccc".into();
    remote.url = "https://www.notion.so/cccccccccccccccccccccccccccccccc".into();
    remote.project = Some(proto::TaskTrackerProjectSnapshot {
        external_id: external_id.into(),
        url: "https://www.notion.so/project".into(),
        title: "Remote project name".into(),
        description: "Remote project description".into(),
        unverified: true,
    });
    let task_id = db
        .task_tracker_import_remote(workspace, proto::TaskTrackerProvider::Notion, &remote, 32)
        .unwrap();
    let task = db.task(task_id).unwrap().unwrap();
    let domain = db.task_domain(task_id).unwrap().unwrap();
    assert_eq!(domain.kind, proto::TaskDomainKind::Delivery);
    assert_eq!(domain.project_id, Some(project.id));
    let link = db.task_external_links(task_id).unwrap().remove(0);
    let conflict = link
        .snapshot
        .conflicts
        .iter()
        .find(|conflict| conflict.field == "project.description")
        .unwrap();
    assert_eq!(conflict.base, "");
    assert_eq!(conflict.local, "Local project description");
    assert_eq!(conflict.remote, "Remote project description");
    let title_conflict = link
        .snapshot
        .conflicts
        .iter()
        .find(|conflict| conflict.field == "project.title")
        .unwrap();
    assert_eq!(title_conflict.local, "Local project name");
    assert_eq!(title_conflict.remote, "Remote project name");
    let unchanged_project = db.task_project(project.id).unwrap().unwrap();
    assert_eq!(
        unchanged_project.tracker_description.as_deref(),
        Some("Local project description")
    );
    assert_eq!(unchanged_project.local_decisions, local_decisions);

    assert!(db
        .task_tracker_conflict_resolve(
            task_id,
            task.revision - 1,
            Some(unchanged_project.revision),
            proto::TaskTrackerProvider::Notion,
            &remote.external_id,
            "project.description",
            link.snapshot.revision,
            &proto::TaskTrackerConflictResolution::Remote,
        )
        .is_err());
    assert_eq!(
        db.task_project(project.id)
            .unwrap()
            .unwrap()
            .tracker_description
            .as_deref(),
        Some("Local project description")
    );
    assert!(db.task_has_unresolved_tracker_conflicts(task_id).unwrap());

    let resolved = db
        .task_tracker_conflict_resolve(
            task_id,
            task.revision,
            Some(unchanged_project.revision),
            proto::TaskTrackerProvider::Notion,
            &remote.external_id,
            "project.description",
            link.snapshot.revision,
            &proto::TaskTrackerConflictResolution::Remote,
        )
        .unwrap()
        .unwrap();
    let updated_project = db.task_project(project.id).unwrap().unwrap();
    assert_eq!(
        updated_project.tracker_description.as_deref(),
        Some("Remote project description")
    );
    assert_eq!(updated_project.local_decisions, local_decisions);
    assert_eq!(updated_project.revision, unchanged_project.revision + 1);
    assert!(db.task_has_unresolved_tracker_conflicts(task_id).unwrap());
    let after_description = db.task_project(project.id).unwrap().unwrap();
    let resolved = db
        .task_tracker_conflict_resolve(
            task_id,
            task.revision,
            Some(after_description.revision),
            proto::TaskTrackerProvider::Notion,
            &remote.external_id,
            "project.title",
            resolved.snapshot.revision,
            &proto::TaskTrackerConflictResolution::Remote,
        )
        .unwrap()
        .unwrap();
    let updated_project = db.task_project(project.id).unwrap().unwrap();
    assert_eq!(updated_project.name, "Remote project name");
    assert!(resolved.snapshot.conflicts.is_empty());
    assert!(!db.task_has_unresolved_tracker_conflicts(task_id).unwrap());
}

#[test]
fn unassigned_task_transition_is_ignored_and_database_namespace_survives_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("tracker-identity.sqlite");
    let db = Db::open(&path).unwrap();
    let namespace = db.task_tracker_database_namespace().unwrap();
    assert_eq!(namespace, db.task_tracker_database_namespace().unwrap());
    let other = Db::open(&temp.path().join("different-tracker-identity.sqlite")).unwrap();
    assert_ne!(namespace, other.task_tracker_database_namespace().unwrap());
    drop(db);
    let reopened = Db::open(&path).unwrap();
    assert_eq!(
        reopened.task_tracker_database_namespace().unwrap(),
        namespace
    );

    let task_id = create_task(&reopened, None, "Unassigned", proto::TaskStatus::Todo, None);
    reopened
        .set_task_tracker_settings(&github_settings("/tmp/tracker-workspace"))
        .unwrap();
    reopened
        .enqueue_task_tracker_action(task_id, "created", 1, 2)
        .unwrap();
    assert!(reopened
        .task_tracker_outbox_pending(i64::MAX, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn slice_writeback_targets_parent_delivery_and_close_retries_revalidate_all_slices() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-slices.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    db.set_task_tracker_settings(&github_settings(workspace))
        .unwrap();
    let project = db
        .create_tracker_project_identity(
            workspace,
            "github_issues:owner/repo:milestone:7",
            "Milestone",
            1,
        )
        .unwrap()
        .unwrap();
    let delivery_id = create_task(
        &db,
        Some(workspace),
        "Delivery",
        proto::TaskStatus::Backlog,
        None,
    );
    assert!(db
        .save_task_domain(
            delivery_id,
            1,
            false,
            proto::TaskDomainKind::Delivery,
            Some(project.id),
            2
        )
        .unwrap());
    let delivery = db.task(delivery_id).unwrap().unwrap();
    let in_review = TaskUpdate {
        workspace: Some(workspace),
        id: delivery_id,
        expected_revision: delivery.revision,
        title: &delivery.title,
        description: &delivery.description,
        status: proto::TaskStatus::InReview,
        priority: delivery.priority,
        parent_id: None,
        ref_url: None,
        acceptance: None,
        actor: "houston:domain",
        action: "status_rollup",
        changes: "{\"status\":true}",
        now_ms: 3,
    };
    assert!(db.update_task(&in_review).unwrap());
    let delivery_source = proto::TaskExternalLink {
        task_id: delivery_id,
        provider: proto::TaskTrackerProvider::GithubIssues,
        external_id: "owner/repo#41".into(),
        url: "https://github.com/owner/repo/issues/41".into(),
        fetched_at_ms: None,
        body_hash: None,
        remote_rev: None,
        synced_at_ms: None,
        source: proto::TaskExternalLinkSource::Source,
        snapshot: proto::TaskTrackerSnapshot {
            base: BTreeMap::new(),
            local: BTreeMap::new(),
            remote: BTreeMap::new(),
            conflicts: vec![],
            revision: 1,
            project_external_id: None,
            project: None,
        },
        sync_state: proto::TaskTrackerSyncState::Current,
    };
    db.task_external_link_upsert(&delivery_source).unwrap();
    let slice_id = create_task(
        &db,
        Some(workspace),
        "Slice one",
        proto::TaskStatus::InProgress,
        Some(delivery_id),
    );
    assert!(db
        .save_task_domain(slice_id, 1, false, proto::TaskDomainKind::Slice, None, 3)
        .unwrap());
    let slice = db.task(slice_id).unwrap().unwrap();
    let run = db
        .create_task_run(&TaskRunWrite {
            task_id: slice_id,
            kind: proto::TaskRunKind::Implementation,
            state: proto::TaskRunState::HandedBack,
            provider: proto::AgentKind::Codex,
            reviewer: None,
            session_id: None,
            delegation_id: None,
            worktree_path: None,
            branch: None,
            base_commit: None,
            initial_revision: slice.revision,
            started_at_ms: 4,
        })
        .unwrap();
    db.task_run_set_pr_url(run.id, Some("https://github.com/owner/repo/pull/9"))
        .unwrap();
    db.task_run_set_summary(run.id, "Slice handback summary")
        .unwrap();

    let sibling_id = create_task(
        &db,
        Some(workspace),
        "Slice two",
        proto::TaskStatus::InProgress,
        Some(delivery_id),
    );
    assert!(db
        .save_task_domain(sibling_id, 1, false, proto::TaskDomainKind::Slice, None, 3)
        .unwrap());
    let sibling = db.task(sibling_id).unwrap().unwrap();
    assert_eq!(sibling.revision, slice.revision);
    let sibling_run = db
        .create_task_run(&TaskRunWrite {
            task_id: sibling_id,
            kind: proto::TaskRunKind::Implementation,
            state: proto::TaskRunState::HandedBack,
            provider: proto::AgentKind::Codex,
            reviewer: None,
            session_id: None,
            delegation_id: None,
            worktree_path: None,
            branch: None,
            base_commit: None,
            initial_revision: sibling.revision,
            started_at_ms: 4,
        })
        .unwrap();
    db.task_run_set_pr_url(
        sibling_run.id,
        Some("https://github.com/owner/repo/pull/10"),
    )
    .unwrap();
    db.task_run_set_summary(sibling_run.id, "Slice handback summary")
        .unwrap();

    db.enqueue_task_tracker_action(slice_id, "handed_back", slice.revision, 5)
        .unwrap();
    db.enqueue_task_tracker_action(sibling_id, "handed_back", sibling.revision, 5)
        .unwrap();
    let outbox = db.task_tracker_outbox_pending(i64::MAX, 10).unwrap();
    assert!(outbox
        .iter()
        .all(|row| [slice_id, sibling_id].contains(&row.task_id)));
    let status: serde_json::Value = serde_json::from_str(
        &outbox
            .iter()
            .find(|row| row.action == "status")
            .unwrap()
            .payload,
    )
    .unwrap();
    assert_eq!(status["delivery_task_id"], delivery_id);
    assert_eq!(status["status"], "in_review");
    let pr: serde_json::Value = serde_json::from_str(
        &outbox
            .iter()
            .find(|row| row.action == "pr_reference")
            .unwrap()
            .payload,
    )
    .unwrap();
    assert_eq!(pr["url"], "https://github.com/owner/repo/pull/9");
    let sibling_pr: serde_json::Value = serde_json::from_str(
        &outbox
            .iter()
            .find(|row| row.task_id == sibling_id && row.action == "pr_reference")
            .unwrap()
            .payload,
    )
    .unwrap();
    assert_eq!(sibling_pr["url"], "https://github.com/owner/repo/pull/10");
    assert_ne!(pr["task_identity"], sibling_pr["task_identity"]);
    let summary: serde_json::Value = serde_json::from_str(
        &outbox
            .iter()
            .find(|row| row.action == "summary_comment")
            .unwrap()
            .payload,
    )
    .unwrap();
    assert_eq!(summary["summary"], "Slice one: Slice handback summary");
    let sibling_summary: serde_json::Value = serde_json::from_str(
        &outbox
            .iter()
            .find(|row| row.task_id == sibling_id && row.action == "summary_comment")
            .unwrap()
            .payload,
    )
    .unwrap();
    assert_eq!(
        sibling_summary["summary"],
        "Slice two: Slice handback summary"
    );
    assert_ne!(summary["task_identity"], sibling_summary["task_identity"]);
    assert!(!outbox.iter().any(|row| row.action == "delivery_close"));

    let slice = db.task(slice_id).unwrap().unwrap();
    let done = TaskUpdate {
        workspace: Some(workspace),
        id: slice_id,
        expected_revision: slice.revision,
        title: &slice.title,
        description: &slice.description,
        status: proto::TaskStatus::Done,
        priority: slice.priority,
        parent_id: Some(delivery_id),
        ref_url: None,
        acceptance: None,
        actor: "test",
        action: "status",
        changes: "{\"status\":true}",
        now_ms: 6,
    };
    assert!(db.update_task(&done).unwrap());
    let delivery = db.task(delivery_id).unwrap().unwrap();
    let rolled_up = TaskUpdate {
        workspace: Some(workspace),
        id: delivery_id,
        expected_revision: delivery.revision,
        title: &delivery.title,
        description: &delivery.description,
        status: proto::TaskStatus::Done,
        priority: delivery.priority,
        parent_id: None,
        ref_url: None,
        acceptance: None,
        actor: "houston:tracker",
        action: "delivery_rolled_up",
        changes: "{\"status\":true}",
        now_ms: 7,
    };
    assert!(db.update_task(&rolled_up).unwrap());
    let delivery = db.task(delivery_id).unwrap().unwrap();
    db.enqueue_task_tracker_action(delivery_id, "delivery_rolled_up", delivery.revision, 7)
        .unwrap();
    let close = db
        .task_tracker_outbox_pending(i64::MAX, 20)
        .unwrap()
        .into_iter()
        .find(|row| row.action == "delivery_close")
        .unwrap();

    let slice = db.task(slice_id).unwrap().unwrap();
    let reopened = TaskUpdate {
        workspace: Some(workspace),
        id: slice_id,
        expected_revision: slice.revision,
        title: &slice.title,
        description: &slice.description,
        status: proto::TaskStatus::InProgress,
        priority: slice.priority,
        parent_id: Some(delivery_id),
        ref_url: None,
        acceptance: None,
        actor: "test",
        action: "status",
        changes: "{\"status\":true}",
        now_ms: 8,
    };
    assert!(db.update_task(&reopened).unwrap());
    assert!(
        db.task_tracker_outbox_current_payload(&close)
            .unwrap()
            .is_none(),
        "a retry must not close an issue after a Slice was reopened"
    );
    db.task_tracker_outbox_sent(close.id, r#"{"superseded":true}"#, 9)
        .unwrap();
    let slice = db.task(slice_id).unwrap().unwrap();
    let completed_again = TaskUpdate {
        workspace: Some(workspace),
        id: slice_id,
        expected_revision: slice.revision,
        title: &slice.title,
        description: &slice.description,
        status: proto::TaskStatus::Done,
        priority: slice.priority,
        parent_id: Some(delivery_id),
        ref_url: None,
        acceptance: None,
        actor: "test",
        action: "status",
        changes: "{\"status\":true}",
        now_ms: 10,
    };
    assert!(db.update_task(&completed_again).unwrap());
    let delivery = db.task(delivery_id).unwrap().unwrap();
    db.enqueue_task_tracker_action(delivery_id, "delivery_rolled_up", delivery.revision, 11)
        .unwrap();
    assert!(db
        .task_tracker_outbox_pending(i64::MAX, 20)
        .unwrap()
        .iter()
        .any(|row| row.action == "delivery_close"));
}

#[test]
fn notion_handed_back_and_merged_summaries_use_distinct_slice_identities() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-notion-slice-identities.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    let mut settings = github_settings(workspace);
    settings.provider = proto::TaskTrackerProvider::Notion;
    settings.github_repository = None;
    settings.github_label = None;
    settings.notion_data_source_id = Some("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into());
    settings.notion_title_property_id = Some("title".into());
    settings.notion_description_property_id = Some("description".into());
    settings.notion_status_property_id = Some("status".into());
    db.set_task_tracker_settings(&settings).unwrap();

    let delivery_id = create_task(
        &db,
        Some(workspace),
        "Delivery",
        proto::TaskStatus::InProgress,
        None,
    );
    assert!(db
        .save_task_domain(
            delivery_id,
            1,
            false,
            proto::TaskDomainKind::Delivery,
            None,
            2
        )
        .unwrap());
    db.task_external_link_upsert(&proto::TaskExternalLink {
        task_id: delivery_id,
        provider: proto::TaskTrackerProvider::Notion,
        external_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(),
        url: "https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        fetched_at_ms: None,
        body_hash: None,
        remote_rev: None,
        synced_at_ms: None,
        source: proto::TaskExternalLinkSource::Source,
        snapshot: proto::TaskTrackerSnapshot {
            base: BTreeMap::new(),
            local: BTreeMap::new(),
            remote: BTreeMap::new(),
            conflicts: vec![],
            revision: 1,
            project_external_id: None,
            project: None,
        },
        sync_state: proto::TaskTrackerSyncState::Current,
    })
    .unwrap();

    let mut slice_ids = Vec::new();
    for _ in 0..2 {
        let slice_id = create_task(
            &db,
            Some(workspace),
            "Slice",
            proto::TaskStatus::InProgress,
            Some(delivery_id),
        );
        assert!(db
            .save_task_domain(slice_id, 1, false, proto::TaskDomainKind::Slice, None, 3)
            .unwrap());
        let slice = db.task(slice_id).unwrap().unwrap();
        let run = db
            .create_task_run(&TaskRunWrite {
                task_id: slice_id,
                kind: proto::TaskRunKind::Implementation,
                state: proto::TaskRunState::HandedBack,
                provider: proto::AgentKind::Codex,
                reviewer: None,
                session_id: None,
                delegation_id: None,
                worktree_path: None,
                branch: None,
                base_commit: None,
                initial_revision: slice.revision,
                started_at_ms: 4,
            })
            .unwrap();
        db.task_run_set_summary(run.id, "Same summary").unwrap();
        slice_ids.push((slice_id, slice.revision));
    }
    assert_eq!(slice_ids[0].1, slice_ids[1].1);

    db.enqueue_task_tracker_action(slice_ids[0].0, "handed_back", slice_ids[0].1, 5)
        .unwrap();
    db.enqueue_task_tracker_action(slice_ids[1].0, "merged", slice_ids[1].1, 5)
        .unwrap();
    let outbox = db.task_tracker_outbox_pending(i64::MAX, 10).unwrap();
    let summaries = slice_ids
        .iter()
        .map(|(task_id, _)| {
            let row = outbox
                .iter()
                .find(|row| row.task_id == *task_id && row.action == "handback_summary")
                .unwrap();
            serde_json::from_str::<serde_json::Value>(&row.payload).unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(summaries[0]["summary"], "Slice: Same summary");
    assert_eq!(summaries[0]["summary"], summaries[1]["summary"]);
    assert_ne!(summaries[0]["task_identity"], summaries[1]["task_identity"]);
}

#[test]
fn explicit_delivery_done_override_closes_but_a_reopened_delivery_cannot_close_on_slice_rollup() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-delivery-override.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    db.set_task_tracker_settings(&github_settings(workspace))
        .unwrap();
    let project = db
        .create_tracker_project_identity(
            workspace,
            "github_issues:owner/repo:milestone:8",
            "Milestone 8",
            70,
        )
        .unwrap()
        .unwrap();
    let delivery_id = create_task(
        &db,
        Some(workspace),
        "Delivery",
        proto::TaskStatus::InReview,
        None,
    );
    assert!(db
        .save_task_domain(
            delivery_id,
            1,
            false,
            proto::TaskDomainKind::Delivery,
            Some(project.id),
            71
        )
        .unwrap());
    assert!(
        db.task_domain(delivery_id)
            .unwrap()
            .unwrap()
            .user_status_override
    );
    let slice_id = create_task(
        &db,
        Some(workspace),
        "Open slice",
        proto::TaskStatus::Todo,
        Some(delivery_id),
    );
    assert!(db
        .save_task_domain(slice_id, 1, false, proto::TaskDomainKind::Slice, None, 72)
        .unwrap());
    db.task_external_link_upsert(&proto::TaskExternalLink {
        task_id: delivery_id,
        provider: proto::TaskTrackerProvider::GithubIssues,
        external_id: "owner/repo#42".into(),
        url: "https://github.com/owner/repo/issues/42".into(),
        fetched_at_ms: None,
        body_hash: None,
        remote_rev: None,
        synced_at_ms: None,
        source: proto::TaskExternalLinkSource::Source,
        snapshot: proto::TaskTrackerSnapshot {
            base: BTreeMap::new(),
            local: BTreeMap::new(),
            remote: BTreeMap::new(),
            conflicts: vec![],
            revision: 1,
            project_external_id: None,
            project: None,
        },
        sync_state: proto::TaskTrackerSyncState::Current,
    })
    .unwrap();

    let delivery = db.task(delivery_id).unwrap().unwrap();
    let explicit_done = TaskUpdate {
        workspace: Some(workspace),
        id: delivery_id,
        expected_revision: delivery.revision,
        title: &delivery.title,
        description: &delivery.description,
        status: proto::TaskStatus::Done,
        priority: delivery.priority,
        parent_id: None,
        ref_url: None,
        acceptance: None,
        actor: "user",
        action: "task_status",
        changes: "{\"status\":true}",
        now_ms: 73,
    };
    assert!(db.update_task(&explicit_done).unwrap());
    let delivery = db.task(delivery_id).unwrap().unwrap();
    db.enqueue_task_tracker_action(delivery_id, "delivery_rolled_up", delivery.revision, 74)
        .unwrap();
    let close = db
        .task_tracker_outbox_pending(i64::MAX, 10)
        .unwrap()
        .into_iter()
        .find(|row| row.action == "delivery_close")
        .unwrap();
    let payload = db
        .task_tracker_outbox_current_payload(&close)
        .unwrap()
        .unwrap();
    assert_eq!(payload["user_override"], true);
    assert_eq!(payload["all_children_done"], false);

    let delivery = db.task(delivery_id).unwrap().unwrap();
    let reopened = TaskUpdate {
        workspace: Some(workspace),
        id: delivery_id,
        expected_revision: delivery.revision,
        title: &delivery.title,
        description: &delivery.description,
        status: proto::TaskStatus::InProgress,
        priority: delivery.priority,
        parent_id: None,
        ref_url: None,
        acceptance: None,
        actor: "user",
        action: "task_status",
        changes: "{\"status\":true}",
        now_ms: 75,
    };
    assert!(db.update_task(&reopened).unwrap());
    assert!(db
        .task_tracker_outbox_current_payload(&close)
        .unwrap()
        .is_none());
}

#[test]
fn project_identity_resolution_requires_the_live_project_revision() {
    let temp = tempfile::tempdir().unwrap();
    let db = Db::open(&temp.path().join("tracker-project-identity-guard.sqlite")).unwrap();
    let workspace = "/tmp/tracker-workspace";
    let id = db
        .task_tracker_import_remote(
            workspace,
            proto::TaskTrackerProvider::GithubIssues,
            &snapshot("Task", "Description", "todo"),
            80,
        )
        .unwrap();
    let project_id = db.task_domain(id).unwrap().unwrap().project_id.unwrap();
    let original_project = db.task_project(project_id).unwrap().unwrap();
    let mut remote = snapshot("Task", "Description", "todo");
    remote.project.as_mut().unwrap().external_id = "github_issues:owner/repo:milestone:8".into();
    remote.project.as_mut().unwrap().url = "https://github.com/owner/repo/milestone/8".into();
    db.task_tracker_import_remote(
        workspace,
        proto::TaskTrackerProvider::GithubIssues,
        &remote,
        81,
    )
    .unwrap();
    let task = db.task(id).unwrap().unwrap();
    let link = db.task_external_links(id).unwrap().remove(0);
    assert!(link
        .snapshot
        .conflicts
        .iter()
        .any(|item| item.field == "project.identity"));
    let current_project = db
        .save_task_project(
            workspace,
            Some(project_id),
            Some(original_project.revision),
            &original_project.name,
            original_project.external_url.as_deref(),
            original_project.tracker_description.as_deref(),
            &["New approved project decision".into()],
            82,
        )
        .unwrap()
        .unwrap();
    for expected in [None, Some(original_project.revision)] {
        assert!(db
            .task_tracker_conflict_resolve(
                id,
                task.revision,
                expected,
                proto::TaskTrackerProvider::GithubIssues,
                &link.external_id,
                "project.identity",
                link.snapshot.revision,
                &proto::TaskTrackerConflictResolution::Local
            )
            .is_err());
    }
    assert_eq!(
        db.task_external_links(id).unwrap()[0].snapshot.revision,
        link.snapshot.revision
    );
    assert!(db
        .task_tracker_conflict_resolve(
            id,
            task.revision,
            Some(current_project.revision),
            proto::TaskTrackerProvider::GithubIssues,
            &link.external_id,
            "project.identity",
            link.snapshot.revision,
            &proto::TaskTrackerConflictResolution::Local
        )
        .unwrap()
        .is_some());
    assert_eq!(
        db.task_domain(id).unwrap().unwrap().project_id,
        Some(project_id)
    );
}
