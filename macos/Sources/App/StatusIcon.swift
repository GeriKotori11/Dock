// Menu-bar icon (HOST-CONTROL-PAGE.md 6.1): a 16 pt template image of the
// four-square BrandMark, filled squares; in the problem state the
// bottom-right square is drawn as an outline. The system tints it.
import AppKit

enum StatusIcon {
    static func image(problem: Bool) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size, flipped: true) { _ in
            let gap: CGFloat = 2
            let inset: CGFloat = 1
            let side = (size.width - inset * 2 - gap) / 2
            let radius = side * 0.22
            NSColor.black.set()
            for index in 0..<4 {
                let col = CGFloat(index % 2), row = CGFloat(index / 2)
                let rect = NSRect(x: inset + col * (side + gap), y: inset + row * (side + gap), width: side, height: side)
                if problem && index == 3 {
                    let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.75, dy: 0.75), xRadius: radius, yRadius: radius)
                    path.lineWidth = 1.5
                    path.stroke()
                } else {
                    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
                }
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "WinDock"
        return image
    }
}
