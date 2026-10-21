// Renders the four-square WinDock BrandMark as the macOS app icon set
// (same colours as ios/scripts/generate-icon.swift, on the macOS icon grid:
// an 824 pt rounded tile inside the 1024 pt canvas).
//
//   cd macos && swift scripts/generate-icon.swift
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1]
              : "Resources/Assets.xcassets/AppIcon.appiconset")

func render(_ pixels: Int) -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let s = CGFloat(pixels) / 1024
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: pixels, height: pixels).fill()
    // Tile
    NSColor(srgbRed: 0.035, green: 0.055, blue: 0.063, alpha: 1).setFill() // #090E10
    NSBezierPath(roundedRect: NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s),
                 xRadius: 185 * s, yRadius: 185 * s).fill()
    let colors: [NSColor] = [
        NSColor(srgbRed: 0.51, green: 0.91, blue: 0.75, alpha: 1), // #82E8BF
        NSColor(srgbRed: 0.78, green: 0.98, blue: 0.91, alpha: 1), // #C7FAE8
        NSColor(srgbRed: 0.50, green: 0.73, blue: 1, alpha: 1),    // #80BAFF
        NSColor(srgbRed: 0.41, green: 0.85, blue: 0.80, alpha: 1), // #69D9CC
    ]
    let side: CGFloat = 268, gap: CGFloat = 64, origin: CGFloat = 512 - side - gap / 2
    for i in 0..<4 {
        colors[i].setFill()
        let x = origin + CGFloat(i % 2) * (side + gap)
        let y = origin + CGFloat(1 - i / 2) * (side + gap)
        NSBezierPath(roundedRect: NSRect(x: x * s, y: y * s, width: side * s, height: side * s),
                     xRadius: 58 * s, yRadius: 58 * s).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

var images: [[String: String]] = []
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
        try render(points * scale).write(to: out.appendingPathComponent(name))
        images.append(["filename": name, "idiom": "mac", "scale": "\(scale)x", "size": "\(points)x\(points)"])
    }
}
let contents: [String: Any] = ["images": images, "info": ["author": "xcode", "version": 1]]
try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys])
    .write(to: out.appendingPathComponent("Contents.json"))
print("Wrote \(images.count) icons to \(out.path)")
