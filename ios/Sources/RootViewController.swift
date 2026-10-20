import UIKit

/// Owns the coordinator and two layers: the dock (always at the bottom, so it survives the switch
/// sheet and the hub over it) and one native screen above it, swapped with a crossfade.
final class RootViewController: UIViewController {
    let coordinator: ConnectionCoordinator
    private let dockContainer = UIView()
    private let screenContainer = UIView()
    private let scrim = UIView()
    private(set) var currentScreen: UIViewController?
    private(set) var dock: DockViewController?
    private var containerAnimator: UIViewPropertyAnimator?
    private var started = false
    private let autoStart: Bool

    init(coordinator: ConnectionCoordinator, autoStart: Bool = true) {
        self.coordinator = coordinator
        self.autoStart = autoStart
        super.init(nibName: nil, bundle: nil)
        coordinator.root = self
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { screenContainer.isHidden && dock != nil }
    override var childForHomeIndicatorAutoHidden: UIViewController? { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        view.tintColor = Theme.accent
        for layer in [dockContainer, screenContainer] {
            layer.backgroundColor = Theme.bg
            view.addSubview(layer)
            layer.pinEdges(to: view)
        }
        scrim.backgroundColor = Theme.scrim
        scrim.alpha = 0
        scrim.isHidden = true
        scrim.isAccessibilityElement = false
        scrim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(scrimTapped)))
        view.addSubview(scrim)
        scrim.pinEdges(to: view)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !started && autoStart {
            started = true
            coordinator.start()
        }
    }

    var hasScreen: Bool { currentScreen != nil && !screenContainer.isHidden }
    var isShowingDock: Bool { dock != nil && screenContainer.isHidden }

    // MARK: Screens

    private var fadeIn: TimeInterval { 0.2 }

    /// Replaces the native screen with a crossfade (or fades the layer in over a live dock).
    func show(_ controller: UIViewController, fade: TimeInterval) {
        guard controller !== currentScreen else {
            if screenContainer.isHidden || screenContainer.alpha < 1 { fadeContainerIn(fade) }
            return
        }
        let old = currentScreen
        currentScreen = controller
        addChild(controller)
        screenContainer.addSubview(controller.view)
        controller.view.pinEdges(to: screenContainer)
        controller.didMove(toParent: self)
        let wasHidden = screenContainer.isHidden || screenContainer.alpha < 1
        if wasHidden {
            removeScreen(old)
            fadeContainerIn(fade)
        } else if let old {
            controller.view.alpha = 0
            Motion.easeOut(fade, { controller.view.alpha = 1 }) { [weak self] _ in self?.removeScreen(old) }
        }
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        if let focus = (controller as? FocusProviding)?.initialFocus {
            DispatchQueue.main.asyncAfter(deadline: .now() + fade) { UIAccessibility.post(notification: .screenChanged, argument: focus) }
        }
    }

    private func fadeContainerIn(_ duration: TimeInterval) {
        containerAnimator?.stopAnimation(true)
        if screenContainer.isHidden {
            screenContainer.alpha = 0
            screenContainer.isHidden = false
        }
        containerAnimator = Motion.easeOut(duration) { self.screenContainer.alpha = 1 }
    }

    private func removeScreen(_ controller: UIViewController?) {
        guard let controller, controller !== currentScreen else { return }
        controller.willMove(toParent: nil)
        controller.view.removeFromSuperview()
        controller.removeFromParent()
    }

    /// Nothing for the first 400 ms: the same flat background as the system launch screen.
    func showBlank() {
        let old = currentScreen
        currentScreen = nil
        removeScreen(old)
        containerAnimator?.stopAnimation(true)
        screenContainer.isHidden = false
        screenContainer.alpha = 1
    }

    /// A minimal "Opening your computer" while the first launch after an update learns the host ID.
    func showConnectingPlaceholder() {
        guard currentScreen == nil else { return }
        show(ConnectingViewController(name: Computer.displayName(nickname: nil, hostName: "")), fade: 0.18)
    }

    /// Removes the native screen without animation, showing the dock (used under a modal).
    func clearScreen() {
        containerAnimator?.stopAnimation(true)
        let old = currentScreen
        currentScreen = nil
        removeScreen(old)
        screenContainer.isHidden = true
        screenContainer.alpha = 1
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    /// The dock is ready: the native overlay fades out over the painted WebView.
    func revealDock() {
        guard !screenContainer.isHidden else { return }
        containerAnimator?.stopAnimation(true)
        let duration = Motion.reduced ? 0.12 : 0.2
        containerAnimator = Motion.easeOut(duration, { self.screenContainer.alpha = 0 }) { [weak self] finished in
            guard let self, finished else { return }
            let old = self.currentScreen
            self.currentScreen = nil
            self.removeScreen(old)
            self.screenContainer.isHidden = true
            self.screenContainer.alpha = 1
            self.setNeedsUpdateOfHomeIndicatorAutoHidden()
        }
    }

    // MARK: Dock

    func installDock(_ dock: DockViewController) {
        if let old = self.dock, old !== dock { removeDock(old) }
        self.dock = dock
        addChild(dock)
        dockContainer.addSubview(dock.view)
        dock.view.pinEdges(to: dockContainer)
        dock.didMove(toParent: self)
    }

    func removeDock(_ dock: DockViewController) {
        dock.willMove(toParent: nil)
        dock.view.removeFromSuperview()
        dock.removeFromParent()
        if self.dock === dock { self.dock = nil }
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    // MARK: Modals

    enum ModalStyle { case fade, fadeScale }
    private var transitions: [ObjectIdentifier: FadeTransition] = [:]

    var topModal: UIViewController? {
        var top = presentedViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    /// Full-screen flows (pairing, add by address, hub over the dock) with the fade / scale transition.
    func presentModal(_ controller: UIViewController, style: ModalStyle) {
        let transition = FadeTransition(scale: style == .fadeScale)
        transitions[ObjectIdentifier(controller)] = transition
        controller.modalPresentationStyle = .overFullScreen
        controller.modalPresentationCapturesStatusBarAppearance = true
        controller.transitioningDelegate = transition
        let presenter = topModal ?? self
        if presenter.isBeingDismissed || presenter.isBeingPresented {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.presentModal(controller, style: style) }
            return
        }
        presenter.present(controller, animated: true)
    }

    /// The Switch computer sheet over the dimmed, still-live dock.
    func presentSheet(_ sheet: SwitchSheetViewController) {
        scrim.isHidden = false
        view.bringSubviewToFront(scrim)
        sheet.onWillDismiss = { [weak self] coordinator in
            guard let self else { return }
            if let coordinator {
                coordinator.animate(alongsideTransition: { _ in self.scrim.alpha = 0 }) { context in
                    if !context.isCancelled { self.scrim.isHidden = true } else { self.scrim.alpha = 1 }
                }
            } else {
                self.scrim.alpha = 0
                self.scrim.isHidden = true
            }
        }
        present(sheet, animated: true)
        if let coordinator = sheet.transitionCoordinator {
            coordinator.animate(alongsideTransition: { _ in self.scrim.alpha = 1 })
        } else {
            scrim.alpha = 1
        }
    }

    @objc private func scrimTapped() {
        if presentedViewController is SwitchSheetViewController { dismiss(animated: true) }
    }

    func dismissModals(animated: Bool, completion: (() -> Void)? = nil) {
        guard presentedViewController != nil else {
            scrim.alpha = 0
            scrim.isHidden = true
            completion?()
            return
        }
        dismiss(animated: animated) { [weak self] in
            self?.scrim.alpha = 0
            self?.scrim.isHidden = true
            self?.transitions = [:]
            completion?()
        }
    }
}

/// Screens that move VoiceOver focus to their title when shown.
protocol FocusProviding { var initialFocus: UIView? { get } }

/// Pairing / Add by address open with opacity 0 → 1 and scale .98 → 1 (240 ms in, 160 ms out);
/// opacity only with Reduce Motion (160 / 120 ms).
final class FadeTransition: NSObject, UIViewControllerTransitioningDelegate, UIViewControllerAnimatedTransitioning {
    let scale: Bool
    private var presenting = true

    init(scale: Bool) { self.scale = scale }

    func animationController(forPresented presented: UIViewController, presenting: UIViewController,
                             source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        self.presenting = true
        return self
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        presenting = false
        return self
    }

    func transitionDuration(using context: UIViewControllerContextTransitioning?) -> TimeInterval {
        if Motion.reduced { return presenting ? 0.16 : 0.12 }
        return presenting ? 0.24 : 0.16
    }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        let duration = transitionDuration(using: context)
        let useScale = scale && !Motion.reduced
        if presenting {
            guard let view = context.view(forKey: .to) else { context.completeTransition(false); return }
            context.containerView.addSubview(view)
            view.frame = context.finalFrame(for: context.viewController(forKey: .to)!)
            view.alpha = 0
            if useScale { view.transform = CGAffineTransform(scaleX: 0.98, y: 0.98) }
            Motion.easeOut(duration, {
                view.alpha = 1
                view.transform = .identity
            }) { _ in context.completeTransition(!context.transitionWasCancelled) }
        } else {
            guard let view = context.view(forKey: .from) else { context.completeTransition(false); return }
            Motion.easeOut(duration, {
                view.alpha = 0
                if useScale { view.transform = CGAffineTransform(scaleX: 0.98, y: 0.98) }
            }) { _ in
                view.removeFromSuperview()
                context.completeTransition(!context.transitionWasCancelled)
            }
        }
    }
}
