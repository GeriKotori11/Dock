import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private(set) var root: RootViewController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.overrideUserInterfaceStyle = .dark
        window.tintColor = Theme.accent
        // Hosted unit tests install their own root; the app itself starts at once.
        let testing = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        let defaults = UserDefaults.standard
        let coordinator = ConnectionCoordinator(store: ComputerStore(defaults: defaults), pins: PinStore(defaults: defaults))
        let root = RootViewController(coordinator: coordinator, autoStart: !testing)
        window.rootViewController = root
        window.makeKeyAndVisible()
        self.window = window
        self.root = root
        keepScreenAwake()
    }

    // The phone screen must never sleep while WinDock is open (every screen, not only the dock).
    // iOS restores the system idle timer on its own when the app goes to the background.
    func sceneWillEnterForeground(_ scene: UIScene) {
        keepScreenAwake()
        currentCoordinator?.sceneWillEnterForeground()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        keepScreenAwake()
        currentCoordinator?.sceneDidBecomeActive()
    }

    private var currentCoordinator: ConnectionCoordinator? {
        (window?.rootViewController as? RootViewController)?.coordinator
    }

    private func keepScreenAwake() {
        UIApplication.shared.isIdleTimerDisabled = true
    }
}
