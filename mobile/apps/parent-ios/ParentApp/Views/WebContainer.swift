import SwiftUI
import WebKit

/* The web view, mounted in SwiftUI. It is created and owned by WebShell so it
   survives every redraw of the chrome around it; this only places it. */
struct WebContainer: UIViewRepresentable {
    let shell: WebShell

    func makeUIView(context: Context) -> WKWebView {
        shell.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
