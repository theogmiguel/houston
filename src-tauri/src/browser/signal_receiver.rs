use gtk::glib::{gobject_ffi, object::ObjectType};

pub(super) fn block_unfiltered_receiver<T: ObjectType>(object: &T, signal_id: u32) -> u32 {
    if signal_id == 0 {
        return 0;
    }
    let instance = object.as_ptr() as *mut gobject_ffi::GObject;
    let mut blocked = 0;
    // GLib's bulk block API requires a closure, function or data match in addition
    // to ID/detail. Find supports ID/detail alone; UNBLOCKED advances this loop
    // without touching the named isolated-world receivers.
    loop {
        // SAFETY: object keeps the instance live. This runs on its owning thread;
        // finding and blocking a handler invokes no user callbacks.
        let handler = unsafe {
            gobject_ffi::g_signal_handler_find(
                instance,
                gobject_ffi::G_SIGNAL_MATCH_ID
                    | gobject_ffi::G_SIGNAL_MATCH_DETAIL
                    | gobject_ffi::G_SIGNAL_MATCH_UNBLOCKED,
                signal_id,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if handler == 0 {
            return blocked;
        }
        // SAFETY: handler was found on this live instance immediately above.
        unsafe { gobject_ffi::g_signal_handler_block(instance, handler) };
        blocked += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gtk::glib::{self, prelude::*, subclass::prelude::*, translate::IntoGlib};
    use std::{cell::Cell, rc::Rc, sync::OnceLock};

    mod imp {
        use super::*;

        #[derive(Default)]
        pub struct Receiver;

        #[glib::object_subclass]
        impl ObjectSubclass for Receiver {
            const NAME: &'static str = "HoustonBrowserSignalReceiverFixture";
            type Type = super::Receiver;
        }

        impl ObjectImpl for Receiver {
            fn signals() -> &'static [glib::subclass::Signal] {
                static SIGNALS: OnceLock<Vec<glib::subclass::Signal>> = OnceLock::new();
                SIGNALS.get_or_init(|| {
                    vec![glib::subclass::Signal::builder("script-message-received")
                        .detailed()
                        .build()]
                })
            }
        }
    }

    glib::wrapper! {
        pub struct Receiver(ObjectSubclass<imp::Receiver>);
    }

    fn connect(object: &Receiver, name: &std::ffi::CStr, count: Rc<Cell<u32>>) {
        unsafe extern "C" fn received(_: *mut gobject_ffi::GObject, data: glib::ffi::gpointer) {
            // SAFETY: connect_raw owns this boxed Rc until handler destruction.
            let count = unsafe { &*(data as *const Rc<Cell<u32>>) };
            count.set(count.get() + 1);
        }
        // SAFETY: fixture signal has no arguments and no return value. As with
        // WebKit's generated binding, connect_raw owns and frees the boxed closure.
        unsafe {
            glib::signal::connect_raw(
                object.as_ptr().cast(),
                name.as_ptr(),
                Some(std::mem::transmute::<
                    unsafe extern "C" fn(*mut gobject_ffi::GObject, glib::ffi::gpointer),
                    unsafe extern "C" fn(),
                >(received)),
                Box::into_raw(Box::new(count)),
            );
        }
    }

    #[test]
    fn blocks_native_unfiltered_receivers_and_preserves_named_worlds() {
        let object: Receiver = glib::Object::new();
        let unfiltered = Rc::new(Cell::new(0));
        let picker = Rc::new(Cell::new(0));
        let tools = Rc::new(Cell::new(0));
        connect(&object, c"script-message-received", unfiltered.clone());
        connect(&object, c"script-message-received", unfiltered.clone());
        connect(
            &object,
            c"script-message-received::trPicker",
            picker.clone(),
        );
        connect(&object, c"script-message-received::trTools", tools.clone());
        let emit = |detail: &str| {
            object.emit_by_name_with_details::<()>(
                "script-message-received",
                glib::Quark::from_str(detail),
                &[],
            );
        };
        emit("trPicker");
        assert_eq!((unfiltered.get(), picker.get(), tools.get()), (2, 1, 0));
        let signal = unsafe {
            gobject_ffi::g_signal_lookup(
                c"script-message-received".as_ptr(),
                Receiver::static_type().into_glib(),
            )
        };
        assert_eq!(block_unfiltered_receiver(&object, signal), 2);
        emit("trPicker");
        emit("trTools");
        assert_eq!((unfiltered.get(), picker.get(), tools.get()), (2, 2, 1));
        assert_eq!(block_unfiltered_receiver(&object, signal), 0);
        assert_eq!(block_unfiltered_receiver(&object, 0), 0);
    }
}
