import SwiftUI

/// Shared tactile feedback for every native McpGo action.
/// Purely visual: does not change click handling or MCP/service state.
struct HubInteractiveButtonStyle: ButtonStyle {
    enum Treatment {
        case existing      // Already has its own card/colored background
        case bordered      // Small secondary control
        case filled        // New primary action with no custom background
        case navigation    // Sidebar and agent list
        case icon          // Small icon-only control
    }

    var treatment: Treatment = .existing
    var accent: Color = Palette.accent

    func makeBody(configuration: Configuration) -> some View {
        Surface(configuration: configuration, treatment: treatment, accent: accent)
    }

    private struct Surface: View {
        let configuration: ButtonStyle.Configuration
        let treatment: Treatment
        let accent: Color

        @Environment(\.isEnabled) private var enabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        private var activeHover: Bool { hovered && enabled }
        private var pressed: Bool { configuration.isPressed && enabled }

        private var shape: RoundedRectangle {
            RoundedRectangle(cornerRadius: treatment == .navigation ? 10 : 9, style: .continuous)
        }

        var body: some View {
            configuration.label
                // Filled buttons have their own background, therefore need
                // internal insets. Otherwise text and the SF Symbol touch its
                // edges (especially the long replacement action).
                .padding(.horizontal, treatment == .filled ? 18 : treatment == .bordered ? 12 : 0)
                .padding(.vertical, treatment == .filled ? 10 : 0)
                .frame(minHeight: treatment == .filled ? 40 : treatment == .bordered ? 28 : 0)
                .contentShape(shape)
                .background {
                    shape.fill(treatment == .filled ? accent : treatment == .bordered ? Palette.inner : .clear)
                }
                .overlay {
                    shape.fill(accent.opacity(activeHover ? (pressed ? 0.055 : 0.105) : 0))
                }
                .overlay {
                    shape.strokeBorder(accent.opacity(activeHover ? 0.50 : treatment == .bordered ? 0.20 : 0), lineWidth: 1)
                }
                .shadow(color: accent.opacity(activeHover && !pressed ? 0.18 : 0),
                        radius: activeHover ? 13 : 0, x: 0, y: activeHover ? 3 : 0)
                .scaleEffect(reduceMotion || !enabled ? 1 : pressed ? 0.961 : activeHover ? (treatment == .navigation ? 1.008 : 1.025) : 1)
                .offset(y: reduceMotion || !enabled ? 0 : pressed ? 1 : activeHover ? -1 : 0)
                .animation(reduceMotion ? nil : .spring(response: 0.21, dampingFraction: 0.68), value: configuration.isPressed)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.17), value: hovered)
                .onHover { hovered = $0 }
        }
    }
}
