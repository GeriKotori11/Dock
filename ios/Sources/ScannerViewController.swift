import AVFoundation
import UIKit
import VisionKit

/// Whether this device can use the in-app scanner (section 10.1).
enum QRScanCapability: Equatable {
    case ready, needsPermission, denied, unsupported

    /// Before A12 (`isSupported` false, also the simulator) or a restricted camera: the in-app
    /// entry points become "Use your Camera app" (the system Camera still opens the link).
    @MainActor static var current: QRScanCapability {
        guard DataScannerViewController.isSupported else { return .unsupported }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined: return .needsPermission
        case .denied: return .denied
        case .restricted: return .unsupported
        case .authorized: return DataScannerViewController.isAvailable ? .ready : .unsupported
        @unknown default: return .unsupported
        }
    }

    @MainActor static var entryTitle: String { current == .unsupported ? "Use your Camera app" : "Scan QR code" }
}

/// Q4: the camera full screen with the guidance rail on the left and a viewfinder that is
/// guidance only (any WinDock code in view is accepted). Without a usable scanner the camera
/// area explains the system Camera instead; with the camera turned off, it links to Settings.
final class ScannerViewController: ScreenViewController, FocusProviding, DataScannerViewControllerDelegate {
    enum Mode: Equatable { case starting, scanning, denied, unsupported, matched }

    private unowned let coordinator: ConnectionCoordinator
    private(set) var mode: Mode = .starting
    private var scanner: DataScannerViewController?
    private let cameraArea = UIView()
    private let cameraGuide = UILayoutGuide()
    private let railFade = RailFade()
    private let closeButton = IconButton(symbol: Theme.Icon.close, label: "Cancel scanning")
    private let torchButton = IconButton(symbol: Theme.Icon.torchOff, label: "Flashlight")
    let titleLabel = Theme.label("Scan the code on your computer", font: Theme.title)
    private let bodyLabel = Theme.label(font: Theme.body, color: Theme.text2)
    let pinInsteadButton = ThemedButton("Enter the PIN instead", kind: .ghost)
    private let viewfinder = ViewfinderBrackets()
    private let caption = PaddedCaption()
    private let fallback = UIStackView()
    private var captionTimer: Timer?
    private var torchOn = false

    var initialFocus: UIView? { titleLabel }

    init(coordinator: ConnectionCoordinator) {
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit { captionTimer?.invalidate() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "scanner"
        view.backgroundColor = Theme.bg
        view.addSubview(cameraArea)
        cameraArea.pinEdges(to: view)
        view.addLayoutGuide(cameraGuide)
        let safe = view.safeAreaLayoutGuide
        let railWidth: CGFloat = 380
        railFade.isUserInteractionEnabled = false
        for subview in [railFade, viewfinder, caption, fallback, closeButton, torchButton, titleLabel, bodyLabel, pinInsteadButton] as [UIView] {
            subview.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(subview)
        }
        titleLabel.accessibilityTraits = .header
        bodyLabel.attributedText = Theme.paragraph("On the computer, open WinDock and choose Pair a new phone.")
        closeButton.accessibilityIdentifier = "scanner-close"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        torchButton.accessibilityIdentifier = "scanner-torch"
        torchButton.addTarget(self, action: #selector(torchTapped), for: .touchUpInside)
        torchButton.isHidden = true
        pinInsteadButton.accessibilityIdentifier = "scanner-pin-instead"
        pinInsteadButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        caption.alpha = 0
        caption.text = "That isn't a WinDock code"
        caption.accessibilityIdentifier = "scanner-caption"
        viewfinder.isAccessibilityElement = false
        fallback.axis = .vertical
        fallback.alignment = .fill
        fallback.isHidden = true
        NSLayoutConstraint.activate([
            railFade.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            railFade.topAnchor.constraint(equalTo: view.topAnchor),
            railFade.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            railFade.trailingAnchor.constraint(equalTo: safe.leadingAnchor, constant: railWidth),
            cameraGuide.leadingAnchor.constraint(equalTo: railFade.trailingAnchor),
            cameraGuide.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            cameraGuide.topAnchor.constraint(equalTo: safe.topAnchor),
            cameraGuide.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
            closeButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            closeButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
            torchButton.leadingAnchor.constraint(equalTo: closeButton.trailingAnchor, constant: 12),
            torchButton.centerYAnchor.constraint(equalTo: closeButton.centerYAnchor),
            titleLabel.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: railFade.trailingAnchor, constant: -40),
            titleLabel.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 16),
            bodyLabel.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            bodyLabel.trailingAnchor.constraint(lessThanOrEqualTo: railFade.trailingAnchor, constant: -40),
            bodyLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 8),
            pinInsteadButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: -12),
            pinInsteadButton.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -12),
            pinInsteadButton.topAnchor.constraint(greaterThanOrEqualTo: bodyLabel.bottomAnchor, constant: 16),
            viewfinder.widthAnchor.constraint(equalToConstant: 214),
            viewfinder.heightAnchor.constraint(equalToConstant: 214),
            viewfinder.centerXAnchor.constraint(equalTo: cameraGuide.centerXAnchor),
            viewfinder.centerYAnchor.constraint(equalTo: cameraGuide.centerYAnchor),
            caption.topAnchor.constraint(equalTo: viewfinder.bottomAnchor, constant: 16),
            caption.centerXAnchor.constraint(equalTo: viewfinder.centerXAnchor),
            fallback.centerXAnchor.constraint(equalTo: cameraGuide.centerXAnchor),
            fallback.centerYAnchor.constraint(equalTo: cameraGuide.centerYAnchor),
            fallback.widthAnchor.constraint(lessThanOrEqualTo: cameraGuide.widthAnchor, constant: -48),
            fallback.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            fallback.topAnchor.constraint(greaterThanOrEqualTo: cameraGuide.topAnchor, constant: 12),
            fallback.bottomAnchor.constraint(lessThanOrEqualTo: cameraGuide.bottomAnchor, constant: -12)
        ])
        // As wide as the camera area allows (minus margins), at most 420.
        let preferredWidth = fallback.widthAnchor.constraint(equalTo: cameraGuide.widthAnchor, constant: -48)
        preferredWidth.priority = UILayoutPriority(999)
        preferredWidth.isActive = true
        view.accessibilityElements = [closeButton, titleLabel, bodyLabel, fallback, pinInsteadButton]
        evaluate()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if mode == .scanning { startScanning() }
        UIAccessibility.post(notification: .screenChanged, argument: titleLabel)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        setTorch(false)
        scanner?.stopScanning()
    }

    override func accessibilityPerformEscape() -> Bool {
        closeTapped()
        return true
    }

    // MARK: Modes

    private func evaluate() {
        switch QRScanCapability.current {
        case .ready: showScanner()
        case .unsupported: showFallback()
        case .denied: showCameraOff()
        case .needsPermission:
            AVCaptureDevice.requestAccess(for: .video) { _ in
                DispatchQueue.main.async { [weak self] in self?.evaluate() }
            }
        }
    }

    private func showScanner() {
        guard scanner == nil else { return }
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                                qualityLevel: .balanced, recognizesMultipleItems: false,
                                                isHighFrameRateTrackingEnabled: false, isGuidanceEnabled: false,
                                                isHighlightingEnabled: false)
        scanner.delegate = self
        addChild(scanner)
        cameraArea.addSubview(scanner.view)
        scanner.view.pinEdges(to: cameraArea)
        scanner.didMove(toParent: self)
        scanner.view.isAccessibilityElement = false
        self.scanner = scanner
        mode = .scanning
        fallback.isHidden = true
        viewfinder.isHidden = false
        torchButton.isHidden = !(AVCaptureDevice.default(for: .video)?.hasTorch ?? false)
        view.accessibilityElements = [closeButton, torchButton, titleLabel, bodyLabel, pinInsteadButton]
        if view.window != nil { startScanning() }
    }

    private func startScanning() {
        guard let scanner, mode == .scanning else { return }
        do {
            try scanner.startScanning()
        } catch {
            // Unavailable after all (restricted, in use by another app): the system Camera path.
            showFallback()
        }
    }

    private func resetCameraArea() {
        scanner?.stopScanning()
        scanner?.willMove(toParent: nil)
        scanner?.view.removeFromSuperview()
        scanner?.removeFromParent()
        scanner = nil
        viewfinder.isHidden = true
        caption.alpha = 0
        torchButton.isHidden = true
        fallback.arrangedSubviews.forEach { $0.removeFromSuperview() }
        fallback.isHidden = false
    }

    /// "Use your Camera app": the system Camera opens `windock://pair` links and asks first.
    private func showFallback() {
        resetCameraArea()
        mode = .unsupported
        fallback.alignment = .fill
        let card = UIView()
        card.backgroundColor = Theme.row
        card.layer.cornerRadius = 16
        card.layer.cornerCurve = .continuous
        let title = Theme.label("Scan with your camera", font: Theme.headline)
        title.accessibilityTraits = .header
        title.accessibilityIdentifier = "scanner-fallback-title"
        let steps = [
            "On the computer, open WinDock and choose **Pair a new phone**.",
            "Open the camera and point it at the code.",
            "Tap the link that appears. WinDock opens and asks before it pairs."
        ]
        let stack = UIStackView(arrangedSubviews: [title] + steps.enumerated().map { NumberedStep(number: $0.offset + 1, text: $0.element) })
        stack.axis = .vertical
        stack.spacing = 14
        stack.setCustomSpacing(16, after: title)
        card.addSubview(stack)
        stack.pinEdges(to: card, insets: UIEdgeInsets(top: 18, left: 18, bottom: 18, right: 18))
        fallback.addArrangedSubview(card)
        view.accessibilityElements = [closeButton, titleLabel, bodyLabel, fallback, pinInsteadButton]
    }

    /// Camera permission denied: "Camera access is off" + Open Settings; the PIN path stays.
    private func showCameraOff() {
        resetCameraArea()
        mode = .denied
        fallback.alignment = .center
        let title = Theme.label("Camera access is off", font: Theme.headline, alignment: .center)
        title.accessibilityIdentifier = "scanner-camera-off"
        let open = ThemedButton("Open Settings", kind: .primary)
        open.accessibilityIdentifier = "scanner-open-settings"
        open.addTarget(self, action: #selector(openSettings), for: .touchUpInside)
        fallback.addArrangedSubview(title)
        fallback.setCustomSpacing(16, after: title)
        fallback.addArrangedSubview(open)
        view.accessibilityElements = [closeButton, titleLabel, bodyLabel, fallback, pinInsteadButton]
    }

    // MARK: Recognition

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        for item in addedItems {
            guard case .barcode(let barcode) = item, let payload = barcode.payloadStringValue else { continue }
            if recognized(payload) { return }
        }
    }

    /// A `windock://pair` payload stops scanning, taps a light haptic, settles the brackets and
    /// opens the confirmation; anything else shows the hint for 2 s (no haptic).
    @discardableResult
    func recognized(_ payload: String) -> Bool {
        guard mode == .scanning else { return false }
        switch PairingLinkParser.route(payload) {
        case .pair(let link):
            mode = .matched
            scanner?.stopScanning()
            setTorch(false)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if !Motion.reduced {
                Motion.easeOut(0.15) { self.viewfinder.transform = CGAffineTransform(scaleX: 0.96, y: 0.96) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                self?.coordinator.presentPairingLink(link)
            }
            return true
        case .newer:
            mode = .matched
            scanner?.stopScanning()
            let alert = UIAlertController(title: "This code needs a newer WinDock app. Update the app, or pair with the PIN instead.",
                                          message: nil, preferredStyle: .alert)
            alert.view.tintColor = Theme.accent
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
                guard let self else { return }
                self.mode = .scanning
                self.startScanning()
            })
            present(alert, animated: true)
            return true
        case .invalid, .notALink:
            showNotWinDock()
            return false
        }
    }

    private func showNotWinDock() {
        captionTimer?.invalidate()
        if caption.alpha < 1 {
            Motion.easeOut(0.15) { self.caption.alpha = 1 }
            UIAccessibility.post(notification: .announcement, argument: caption.text)
        }
        captionTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            guard let self else { return }
            Motion.easeOut(0.15) { self.caption.alpha = 0 }
        }
    }

    // MARK: Actions

    @objc private func closeTapped() {
        setTorch(false)
        scanner?.stopScanning()
        dismiss(animated: true)
    }

    @objc private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    @objc private func torchTapped() { setTorch(!torchOn) }

    private func setTorch(_ on: Bool) {
        guard on != torchOn, let device = AVCaptureDevice.default(for: .video), device.hasTorch,
              (try? device.lockForConfiguration()) != nil else { return }
        device.torchMode = on ? .on : .off
        device.unlockForConfiguration()
        torchOn = on
        torchButton.configuration?.image = Theme.symbol(on ? Theme.Icon.torchOn : Theme.Icon.torchOff, size: 17, weight: .medium)
        torchButton.accessibilityValue = on ? "On" : "Off"
    }
}

/// The rail's backdrop: `bg` at 94% fading to clear over the camera.
final class RailFade: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }
    override init(frame: CGRect) {
        super.init(frame: frame)
        let gradient = layer as! CAGradientLayer
        gradient.colors = [Theme.bg.withAlphaComponent(0.94).cgColor, Theme.bg.withAlphaComponent(0.94).cgColor, Theme.bg.withAlphaComponent(0).cgColor]
        gradient.locations = [0, 0.7, 1]
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// 214 pt guidance square: four accent corner brackets.
final class ViewfinderBrackets: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        contentMode = .redraw
        isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func draw(_ rect: CGRect) {
        let inset: CGFloat = 2.5, arm: CGFloat = 30, radius: CGFloat = 14
        let box = bounds.insetBy(dx: inset, dy: inset)
        let path = UIBezierPath()
        // Top left, top right, bottom right, bottom left: each an arm, a rounded corner, an arm.
        path.move(to: CGPoint(x: box.minX, y: box.minY + arm))
        path.addLine(to: CGPoint(x: box.minX, y: box.minY + radius))
        path.addArc(withCenter: CGPoint(x: box.minX + radius, y: box.minY + radius), radius: radius, startAngle: .pi, endAngle: 1.5 * .pi, clockwise: true)
        path.addLine(to: CGPoint(x: box.minX + arm, y: box.minY))
        path.move(to: CGPoint(x: box.maxX - arm, y: box.minY))
        path.addLine(to: CGPoint(x: box.maxX - radius, y: box.minY))
        path.addArc(withCenter: CGPoint(x: box.maxX - radius, y: box.minY + radius), radius: radius, startAngle: 1.5 * .pi, endAngle: 0, clockwise: true)
        path.addLine(to: CGPoint(x: box.maxX, y: box.minY + arm))
        path.move(to: CGPoint(x: box.maxX, y: box.maxY - arm))
        path.addLine(to: CGPoint(x: box.maxX, y: box.maxY - radius))
        path.addArc(withCenter: CGPoint(x: box.maxX - radius, y: box.maxY - radius), radius: radius, startAngle: 0, endAngle: 0.5 * .pi, clockwise: true)
        path.addLine(to: CGPoint(x: box.maxX - arm, y: box.maxY))
        path.move(to: CGPoint(x: box.minX + arm, y: box.maxY))
        path.addLine(to: CGPoint(x: box.minX + radius, y: box.maxY))
        path.addArc(withCenter: CGPoint(x: box.minX + radius, y: box.maxY - radius), radius: radius, startAngle: 0.5 * .pi, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: box.minX, y: box.maxY - arm))
        path.lineWidth = 4
        path.lineCapStyle = .round
        Theme.accent.setStroke()
        path.stroke()
    }
}

/// "That isn't a WinDock code" under the viewfinder, legible over any camera image.
final class PaddedCaption: UILabel {
    override init(frame: CGRect) {
        super.init(frame: frame)
        font = Theme.font(13, .medium)
        adjustsFontForContentSizeCategory = true
        textColor = Theme.text
        backgroundColor = Theme.bg.withAlphaComponent(0.8)
        textAlignment = .center
        layer.cornerRadius = 10
        layer.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 24, height: max(32, size.height + 12))
    }
}

/// One numbered step of the "Scan with your camera" card.
final class NumberedStep: UIStackView {
    init(number: Int, text: String) {
        super.init(frame: .zero)
        let badge = Theme.label("\(number)", font: Theme.font(13, .semibold), color: Theme.text2, alignment: .center)
        badge.backgroundColor = Theme.glyphFill
        badge.layer.cornerRadius = 12
        badge.layer.masksToBounds = true
        badge.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([badge.widthAnchor.constraint(equalToConstant: 24), badge.heightAnchor.constraint(equalToConstant: 24)])
        let label = Theme.label(font: Theme.font(14), color: Theme.text2)
        label.attributedText = Theme.rich(text, font: Theme.font(14), lineHeight: 1.4)
        addArrangedSubview(badge)
        addArrangedSubview(label)
        spacing = 12
        alignment = .top
        isAccessibilityElement = true
        accessibilityLabel = "\(number). \(label.attributedText?.string ?? text)"
    }
    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
