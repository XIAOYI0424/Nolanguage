//! Desktop entry.
//!
//! Deliberately thin: `lib.rs::run()` owns the wiring, so the same application
//! can also be built as a mobile target without a second entry point.

// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nolanguage_lib::run()
}
