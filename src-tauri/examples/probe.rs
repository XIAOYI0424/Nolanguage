// Minimal WebView2 probe — is the failure ours, or the environment?
//
// `tauri-shell.log` says `page-load never finished within 20s` for the real
// shell. That message cannot tell the two possible causes apart:
//
//   a) our window config / IPC / hardening breaks WebView2, or
//   b) wry + this machine's WebView2 runtime cannot create a browser at all.
//
// This example is the control experiment: one window, one inline data URL, no
// IPC, no config, no hardening. It writes a marker file when the page finishes
// loading, so the answer is a file on disk rather than a screenshot.
//
//   cargo build --example probe --release
//   src-tauri\target\release\examples\probe.exe <marker-file>
//
// If the marker appears, the environment is fine and the shell is at fault.
// If it does not, the runtime/wry pair is the problem — no amount of shell
// code will fix it.
fn main() {
    let marker = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "probe-loaded.txt".to_string());
    let marker_for_load = marker.clone();

    tauri::Builder::default()
        .on_page_load(move |_webview, payload| {
            if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                let _ = std::fs::write(&marker_for_load, "loaded\n");
            }
        })
        .setup(move |app| {
            let url: tauri::Url = "data:text/html,<html><body style='background:%231E1F22;color:%23DFE1E5;font-family:sans-serif'><h1>probe</h1></body></html>"
                .parse()
                .expect("data url");
            tauri::WebviewWindowBuilder::new(app, "probe", tauri::WebviewUrl::External(url))
                .title("probe")
                .inner_size(420.0, 240.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run");
}
