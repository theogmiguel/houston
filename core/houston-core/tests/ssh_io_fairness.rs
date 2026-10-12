#![cfg(feature = "test-barriers")]

use houston_core::ssh::{SshIoEvent, SshIoScheduler};
use tokio::sync::{mpsc, watch};

#[tokio::test]
async fn ready_output_resize_and_input_each_get_a_turn() {
    let (_stop, mut cancel) = watch::channel(false);
    let (output, mut output_rx) = mpsc::channel(1);
    let (resize, mut resize_rx) = watch::channel((80, 24));
    let (input, mut input_rx) = mpsc::channel(1);
    output.try_send(b"output").unwrap();
    input.try_send(b"input").unwrap();
    let mut scheduler = SshIoScheduler::default();
    let mut turns = Vec::new();

    for _ in 0..12 {
        // Refill immediately so inbound data, input and resize stay ready. Each
        // winner is a poll-order receipt, independent of machine speed.
        resize.send_replace((100, 40));
        match scheduler
            .next(
                cancel.changed(),
                output_rx.recv(),
                resize_rx.changed(),
                input_rx.recv(),
            )
            .await
        {
            SshIoEvent::Output(data) => {
                assert_eq!(data, Some(b"output"));
                output.try_send(b"output").unwrap();
                turns.push("output");
            }
            SshIoEvent::Resize(result) => {
                result.unwrap();
                assert_eq!(*resize_rx.borrow_and_update(), (100, 40));
                turns.push("resize");
            }
            SshIoEvent::Input(data) => {
                assert_eq!(data, Some(b"input"));
                input.try_send(b"input").unwrap();
                turns.push("input");
            }
            SshIoEvent::Cancelled => panic!("fixture was not cancelled"),
        }
    }
    assert_eq!(turns, ["output", "resize", "input"].repeat(4));
}

#[tokio::test]
async fn pending_delivery_keeps_output_and_resize_fair_and_cancel_preempts_both() {
    let (stop, mut cancel) = watch::channel(false);
    let (output, mut output_rx) = mpsc::channel(1);
    let (resize, mut resize_rx) = watch::channel((80, 24));
    output.try_send(b"output").unwrap();
    let mut scheduler = SshIoScheduler::default();
    let delivery = std::future::pending::<()>();
    tokio::pin!(delivery);
    let mut turns = Vec::new();

    for _ in 0..8 {
        resize.send_replace((100, 40));
        match scheduler
            .next(
                cancel.changed(),
                output_rx.recv(),
                resize_rx.changed(),
                &mut delivery,
            )
            .await
        {
            SshIoEvent::Output(data) => {
                assert_eq!(data, Some(b"output"));
                output.try_send(b"output").unwrap();
                turns.push("output");
            }
            SshIoEvent::Resize(result) => {
                result.unwrap();
                resize_rx.borrow_and_update();
                turns.push("resize");
            }
            _ => panic!("pending delivery and cancellation cannot win"),
        }
    }
    assert_eq!(turns, ["output", "resize"].repeat(4));
    resize.send_replace((120, 50));
    stop.send_replace(true);
    assert!(matches!(
        scheduler
            .next(
                cancel.changed(),
                output_rx.recv(),
                resize_rx.changed(),
                std::future::ready(()),
            )
            .await,
        SshIoEvent::Cancelled
    ));
    assert_eq!(output_rx.len(), 1, "cancel must not consume ready output");
    assert!(
        resize_rx.has_changed().unwrap(),
        "cancel must not consume resize"
    );
}
