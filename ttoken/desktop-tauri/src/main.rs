//! Entry point of the TTOken Code Desktop shell.

// Release builds are GUI programs on Windows; debug builds keep a console for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ttoken_code_desktop::run();
}
