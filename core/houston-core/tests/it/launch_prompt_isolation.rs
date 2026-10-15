use houston_core::launch::prompt_text;

#[test]
fn sibling_launches_can_reread_their_original_briefs() {
    let directory = tempfile::tempdir().unwrap();
    let first = "First agent: repair hooks.\n".repeat(1024);
    let second = "Second agent: review voice settings.\n".repeat(1024);
    let (_, first_file) = prompt_text(&first, Some(directory.path()), "spawned").unwrap();
    let (first_path, first_contents) = first_file.unwrap();
    std::fs::write(&first_path, first_contents).unwrap();
    let (_, second_file) = prompt_text(&second, Some(directory.path()), "spawned").unwrap();
    let (second_path, second_contents) = second_file.unwrap();
    std::fs::write(&second_path, second_contents).unwrap();

    assert_eq!(std::fs::read_to_string(first_path).unwrap(), first);
    assert_eq!(std::fs::read_to_string(second_path).unwrap(), second);
}
