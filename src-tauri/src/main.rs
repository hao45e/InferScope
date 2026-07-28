// Prevents additional console window on Windows in release, DO NOT REMOVE!!
// Note: this also means `inferscope bench ...` output is invisible in a
// release build on Windows (no console attached) — redirect to a file via
// `--output` there, or use a debug build. Not an issue on macOS/Linux, which
// covers the primary target (headless CI runners).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("bench") {
        std::process::exit(inferscope_lib::cli::run(&args[2..]));
    }
    inferscope_lib::run()
}
