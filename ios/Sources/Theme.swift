import UIKit

/// Design tokens from docs/design/PHONE-CONNECTION-FLOW.md, section 6.
enum Theme {
    static func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
                blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
    }

    static let bg = rgb(0x090E10)
    static let row = rgb(0x13191B)
    static let rowPressed = rgb(0x1A2224)
    static let sheet = rgb(0x151D20)
    static let field = rgb(0x171F22)
    static let line = UIColor(white: 1, alpha: 0.07)
    static let lineStrong = UIColor(white: 1, alpha: 0.12)
    static let text = rgb(0xEEF3F1)
    static let text2 = rgb(0xA0AFAF)
    static let text3 = rgb(0x7D8C8E)
    static let idle = rgb(0x5E6E70)
    static let accent = rgb(0x82E8BF)
    static let onAccent = rgb(0x0A1C1A)
    static let accentTint = accent.withAlphaComponent(0.10)
    static let accentLine = accent.withAlphaComponent(0.30)
    static let live = rgb(0xA3E6BE)
    static let danger = rgb(0xED9695)
    static let dangerText = rgb(0xF1AAA6)
    static let dangerTint = danger.withAlphaComponent(0.12)
    static let dangerLine = dangerText.withAlphaComponent(0.30)
    static let scrim = UIColor(red: 3 / 255, green: 7 / 255, blue: 9 / 255, alpha: 0.62)
    static let secondaryFill = UIColor(white: 1, alpha: 0.07)
    static let glyphFill = UIColor(white: 1, alpha: 0.06)
    static let sheetGroup = UIColor(white: 1, alpha: 0.04)

    /// System fonts scaled with Dynamic Type (section 6, Type).
    static func font(_ size: CGFloat, _ weight: UIFont.Weight = .regular, mono: Bool = false) -> UIFont {
        let base = mono ? UIFont.monospacedSystemFont(ofSize: size, weight: weight) : UIFont.systemFont(ofSize: size, weight: weight)
        return UIFontMetrics(forTextStyle: .body).scaledFont(for: base)
    }

    static var display: UIFont { font(28, .semibold) }
    static var title: UIFont { font(21, .semibold) }
    static var headline: UIFont { font(17, .semibold) }
    static var body: UIFont { font(15) }
    static var subhead: UIFont { font(13) }
    static var label: UIFont { font(13, .semibold) }
    static var caption: UIFont { font(12) }

    static func label(_ text: String? = nil, font: UIFont, color: UIColor = Theme.text, lines: Int = 0,
                      alignment: NSTextAlignment = .natural) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = font
        label.textColor = color
        label.numberOfLines = lines
        label.textAlignment = alignment
        label.adjustsFontForContentSizeCategory = true
        return label
    }

    /// Body text with the spec's 1.45 line height.
    static func paragraph(_ text: String, font: UIFont = Theme.body, color: UIColor = Theme.text2,
                          lineHeight: CGFloat = 1.45, alignment: NSTextAlignment = .natural) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.lineHeightMultiple = lineHeight / 1.2
        style.alignment = alignment
        return NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: style])
    }

    /// Body text where `**bold**` spans are drawn in `text` / semibold and `` `code` `` spans in mono.
    static func rich(_ text: String, font: UIFont = Theme.body, color: UIColor = Theme.text2, lineHeight: CGFloat = 1.45) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let style = NSMutableParagraphStyle()
        style.lineHeightMultiple = lineHeight / 1.2
        var bold = false, code = false
        var current = ""
        func flush() {
            guard !current.isEmpty else { return }
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: style]
            if bold {
                attributes[.font] = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: font.pointSize, weight: .semibold))
                attributes[.foregroundColor] = Theme.text
            }
            if code {
                attributes[.font] = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular))
                attributes[.foregroundColor] = Theme.text
            }
            result.append(NSAttributedString(string: current, attributes: attributes))
            current = ""
        }
        var index = text.startIndex
        while index < text.endIndex {
            if text[index...].hasPrefix("**") { flush(); bold.toggle(); index = text.index(index, offsetBy: 2); continue }
            if text[index] == "`" { flush(); code.toggle(); index = text.index(after: index); continue }
            current.append(text[index])
            index = text.index(after: index)
        }
        flush()
        return result
    }

    static func symbol(_ name: String, size: CGFloat, weight: UIImage.SymbolWeight = .regular) -> UIImage? {
        let config = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
        return UIImage(systemName: name, withConfiguration: config) ?? UIImage(systemName: "circle", withConfiguration: config)
    }

    /// Icon names (SF Symbols standing in for the mockups' line icons).
    enum Icon {
        static let monitor = "display"
        static let shield = "exclamationmark.shield"
        static let clock = "clock"
        static let network = "point.3.connected.trianglepath.dotted"
        static let search = "magnifyingglass"
        static let settings = "gearshape"
        static let check = "checkmark"
        static let plus = "plus"
        static let more = "ellipsis"
        static let close = "xmark"
        static let wifiOff = "wifi.slash"
        static let warning = "exclamationmark.circle"
    }
}

// MARK: - Motion

enum Motion {
    static var reduced: Bool { UIAccessibility.isReduceMotionEnabled }

    /// The spec's ease-out curve, cubic-bezier(0.23, 1, 0.32, 1).
    @discardableResult
    static func easeOut(_ duration: TimeInterval, delay: TimeInterval = 0, _ animations: @escaping () -> Void,
                        completion: ((Bool) -> Void)? = nil) -> UIViewPropertyAnimator {
        let animator = UIViewPropertyAnimator(duration: duration, controlPoint1: CGPoint(x: 0.23, y: 1),
                                              controlPoint2: CGPoint(x: 0.32, y: 1), animations: animations)
        animator.isInterruptible = true
        animator.addCompletion { completion?($0 == .end) }
        animator.startAnimation(afterDelay: delay)
        return animator
    }

    /// A plain crossfade on a label or small element (150 ms ease).
    static func crossfade(_ view: UIView, duration: TimeInterval = 0.15, _ changes: @escaping () -> Void) {
        UIView.transition(with: view, duration: duration, options: [.transitionCrossDissolve, .beginFromCurrentState, .allowUserInteraction],
                          animations: changes)
    }
}

// MARK: - Buttons

/// 48 pt buttons (section 7): primary, secondary, ghost and danger-tint. Press = scale .97.
final class ThemedButton: UIButton {
    enum Kind { case primary, secondary, ghost, danger, ghostSmall }
    let kind: Kind
    var isBusy = false { didSet { updateBusy() } }
    var busyTitle: String?
    private var normalTitle: String

    init(_ title: String, kind: Kind, image: String? = nil) {
        self.kind = kind
        self.normalTitle = title
        super.init(frame: .zero)
        var config = UIButton.Configuration.plain()
        let background: UIColor
        switch kind {
        case .primary:
            background = Theme.accent
            config.baseForegroundColor = Theme.onAccent
        case .secondary:
            background = Theme.secondaryFill
            config.baseForegroundColor = Theme.text
        case .ghost, .ghostSmall:
            background = .clear
            config.baseForegroundColor = Theme.accent
        case .danger:
            background = Theme.dangerTint
            config.baseForegroundColor = Theme.dangerText
            config.background.strokeColor = Theme.dangerLine
            config.background.strokeWidth = 1
        }
        let small = kind == .ghostSmall
        // Explicit colours: the system would otherwise derive fills from the tint colour.
        config.background.backgroundColor = background
        config.background.backgroundColorTransformer = UIConfigurationColorTransformer { _ in background }
        config.background.cornerRadius = small ? 10 : 12
        config.cornerStyle = .fixed
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: kind == .ghost ? 12 : (small ? 14 : 20),
                                                       bottom: 8, trailing: kind == .ghost ? 12 : (small ? 14 : 20))
        config.imagePadding = 8
        if let image { config.image = Theme.symbol(image, size: 15, weight: .medium) }
        let foreground = config.baseForegroundColor ?? Theme.text
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(small ? 13 : 15, .semibold)
            attributes.foregroundColor = foreground
            return attributes
        }
        config.title = title
        config.activityIndicatorColorTransformer = UIConfigurationColorTransformer { _ in foreground }
        configuration = config
        titleLabel?.adjustsFontForContentSizeCategory = true
        configurationUpdateHandler = { button in
            button.alpha = button.isEnabled || (button as? ThemedButton)?.isBusy == true ? 1 : 0.4
        }
        let height = heightAnchor.constraint(greaterThanOrEqualToConstant: small ? 44 : 48)
        height.isActive = true
        addTarget(self, action: #selector(pressDown), for: [.touchDown, .touchDragEnter])
        addTarget(self, action: #selector(pressUp), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func setTitle(_ title: String) {
        normalTitle = title
        if !isBusy { configuration?.title = title }
    }

    private func updateBusy() {
        configuration?.showsActivityIndicator = isBusy
        configuration?.title = isBusy ? (busyTitle ?? normalTitle) : normalTitle
        isUserInteractionEnabled = !isBusy
    }

    @objc private func pressDown() {
        guard !Motion.reduced else { return }
        Motion.easeOut(0.1) { self.transform = CGAffineTransform(scaleX: 0.97, y: 0.97) }
    }

    @objc private func pressUp() {
        guard !Motion.reduced else { return }
        Motion.easeOut(0.16) { self.transform = .identity }
    }
}

/// 44 pt filled icon button (top-left close control).
final class IconButton: UIButton {
    init(symbol: String, label: String, filled: Bool = true) {
        super.init(frame: .zero)
        var config: UIButton.Configuration = filled ? .filled() : .plain()
        config.baseBackgroundColor = Theme.secondaryFill
        config.baseForegroundColor = filled ? Theme.text : Theme.text3
        config.image = Theme.symbol(symbol, size: 17, weight: .medium)
        config.background.cornerRadius = 12
        config.cornerStyle = .fixed
        configuration = config
        accessibilityLabel = label
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: 44), heightAnchor.constraint(equalToConstant: 44)])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// Icon + label link in the rail (44 tall, accent icon).
final class RailLink: UIButton {
    init(_ title: String, symbol: String) {
        super.init(frame: .zero)
        var config = UIButton.Configuration.plain()
        config.image = Theme.symbol(symbol, size: 17, weight: .regular)
        config.imagePadding = 12
        config.baseForegroundColor = Theme.text
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 12)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Theme.font(15, .medium)
            return attributes
        }
        config.title = title
        configuration = config
        tintColor = Theme.accent
        configurationUpdateHandler = { button in
            button.configuration?.imageColorTransformer = UIConfigurationColorTransformer { _ in Theme.accent }
        }
        contentHorizontalAlignment = .leading
        heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

// MARK: - Small components

/// Square tile holding a line glyph: neutral, accent or danger; 40 or 56 pt.
final class GlyphTile: UIView {
    enum Tone { case neutral, accent, danger, clear }
    private let imageView = UIImageView()
    private let size: CGFloat

    init(symbol: String, tone: Tone = .neutral, size: CGFloat = 40) {
        self.size = size
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        layer.cornerRadius = size >= 56 ? 16 : (size <= 32 ? 10 : 12)
        layer.cornerCurve = .continuous
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .center
        addSubview(imageView)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size), heightAnchor.constraint(equalToConstant: size),
            imageView.centerXAnchor.constraint(equalTo: centerXAnchor), imageView.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        isAccessibilityElement = false
        set(symbol: symbol, tone: tone)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func set(symbol: String, tone: Tone) {
        let glyph: CGFloat = size >= 56 ? 25 : (size <= 32 ? 16 : 19)
        imageView.image = Theme.symbol(symbol, size: glyph, weight: .regular)
        switch tone {
        case .neutral: backgroundColor = Theme.glyphFill; imageView.tintColor = Theme.text2
        case .accent: backgroundColor = Theme.accentTint; imageView.tintColor = Theme.accent
        case .danger: backgroundColor = Theme.dangerTint; imageView.tintColor = Theme.dangerText
        case .clear: backgroundColor = .clear; imageView.tintColor = Theme.accent
        }
    }
}

/// 7 pt status dot: filled = reachable, ring = not found, danger. Always next to a word.
final class StatusDot: UIView {
    enum Style { case live, ring, danger }
    var style: Style = .live { didSet { setNeedsDisplay() } }

    init(_ style: Style = .live) {
        self.style = style
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        contentMode = .redraw
        isAccessibilityElement = false
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: 7), heightAnchor.constraint(equalToConstant: 7)])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func draw(_ rect: CGRect) {
        switch style {
        case .live: Theme.live.setFill(); UIBezierPath(ovalIn: bounds).fill()
        case .danger: Theme.dangerText.setFill(); UIBezierPath(ovalIn: bounds).fill()
        case .ring:
            Theme.idle.setStroke()
            let path = UIBezierPath(ovalIn: bounds.insetBy(dx: 0.75, dy: 0.75))
            path.lineWidth = 1.5
            path.stroke()
        }
    }
}

/// The 16 pt system spinner.
func makeSpinner(color: UIColor = Theme.text2) -> UIActivityIndicatorView {
    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.color = color
    spinner.hidesWhenStopped = true
    spinner.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
    spinner.isAccessibilityElement = false
    return spinner
}

/// The four-square WinDock mark (decorative).
final class BrandMark: UIView {
    init(size: CGFloat) {
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        contentMode = .redraw
        isAccessibilityElement = false
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: size), heightAnchor.constraint(equalToConstant: size)])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func draw(_ rect: CGRect) {
        let colors = [Theme.rgb(0x82E8BF), Theme.rgb(0xC7FAE8), Theme.rgb(0x80BAFF), Theme.rgb(0x69D9CC)]
        let size = bounds.width * 0.42
        for i in 0..<4 {
            colors[i].setFill()
            UIBezierPath(roundedRect: CGRect(x: CGFloat(i % 2) * bounds.width * 0.58, y: CGFloat(i / 2) * bounds.height * 0.58,
                                             width: size, height: size), cornerRadius: size * 0.22).fill()
        }
    }
}

/// BrandMark 26 + "WinDock" 17/600.
func makeBrandRow() -> UIView {
    let name = Theme.label("WinDock", font: Theme.headline)
    name.isAccessibilityElement = false
    let row = UIStackView(arrangedSubviews: [BrandMark(size: 26), name])
    row.spacing = 10
    row.alignment = .center
    return row
}

/// Rounded `row`-surface card with a glyph and rich text (instruction card).
final class InstructionCard: UIView {
    let textLabel = Theme.label(font: Theme.subhead, color: Theme.text2)

    init(symbol: String, tone: GlyphTile.Tone = .neutral, text: NSAttributedString) {
        super.init(frame: .zero)
        backgroundColor = Theme.row
        layer.cornerRadius = 16
        layer.cornerCurve = .continuous
        let glyph = GlyphTile(symbol: symbol, tone: tone, size: 32)
        textLabel.attributedText = text
        let stack = UIStackView(arrangedSubviews: [glyph, textLabel])
        stack.spacing = 12
        stack.alignment = .top
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16)
        ])
        isAccessibilityElement = true
        accessibilityLabel = text.string
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// Screens that can wait indefinitely stop their spinners after 60 s and dim to 60% after
/// 2 minutes without a touch (section 9.4). Retries continue underneath.
final class IdleDimmer: NSObject, UIGestureRecognizerDelegate {
    private weak var content: UIView?
    private var timer: Timer?
    private var dimmed = false
    var dimAfter: TimeInterval = 120

    init(content: UIView, host: UIView) {
        self.content = content
        super.init()
        let touch = TouchObserver(target: self, action: #selector(touched))
        touch.cancelsTouchesInView = false
        touch.delaysTouchesBegan = false
        touch.delaysTouchesEnded = false
        touch.delegate = self
        host.addGestureRecognizer(touch)
        restart()
    }

    func restart() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: dimAfter, repeats: false) { [weak self] _ in self?.dim() }
    }

    func stop() { timer?.invalidate(); timer = nil }

    private func dim() {
        guard let content, !dimmed else { return }
        dimmed = true
        UIView.animate(withDuration: 1, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut, .allowUserInteraction]) {
            content.alpha = 0.6
        }
    }

    @objc private func touched() {
        if dimmed, let content {
            dimmed = false
            UIView.animate(withDuration: 0.15, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) { content.alpha = 1 }
        }
        restart()
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    deinit { timer?.invalidate() }
}

/// Reports every touch-down without interfering with other recognizers.
private final class TouchObserver: UIGestureRecognizer {
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        state = .began
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { state = .ended }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .cancelled }
}

extension UIView {
    func pinEdges(to other: UIView, insets: UIEdgeInsets = .zero) {
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: other.leadingAnchor, constant: insets.left),
            trailingAnchor.constraint(equalTo: other.trailingAnchor, constant: -insets.right),
            topAnchor.constraint(equalTo: other.topAnchor, constant: insets.top),
            bottomAnchor.constraint(equalTo: other.bottomAnchor, constant: -insets.bottom)
        ])
    }

    func pinEdges(to guide: UILayoutGuide, insets: UIEdgeInsets = .zero) {
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: insets.left),
            trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -insets.right),
            topAnchor.constraint(equalTo: guide.topAnchor, constant: insets.top),
            bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -insets.bottom)
        ])
    }
}

extension UITraitCollection {
    /// Above xxxLarge, two-column screens collapse into one scrolling column (section 9.3).
    var prefersSingleColumn: Bool { preferredContentSizeCategory.isAccessibilityCategory }
}

/// Status-bar-hidden, landscape, dark base for every native screen.
class ScreenViewController: UIViewController {
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        view.tintColor = Theme.accent
        view.maximumContentSizeCategory = .accessibilityLarge
    }

    func announceScreen(focus: UIView?) {
        UIAccessibility.post(notification: .screenChanged, argument: focus)
    }
}
